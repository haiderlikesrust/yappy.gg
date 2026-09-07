import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { InteractionResponse } from '@yappy/shared';
import { requireMember } from './access.js';
import { applyReportAction } from './staffspace.js';
import { supportReplyEmail } from './mailer.js';
import { Storage } from './storage.js';
import { env } from '../env.js';
import type { YapperReply } from './yapper.js';

export const STAFF_COMMANDS = [
  {
    name: 'health',
    description: 'Check API, database, uploads and job queues',
    usage: '/health',
    staffOnly: true,
  },
  {
    name: 'case',
    description: 'Read a report or support request; add private staff notes',
    usage: '/case REF',
    staffOnly: true,
  },
  {
    name: 'suspend',
    description: 'Review and confirm a timed account suspension',
    usage: '/suspend @user 7d REASON',
    staffOnly: true,
  },
  {
    name: 'warn',
    description: 'Review and send an official account warning',
    usage: '/warn @user REASON',
    staffOnly: true,
  },
  {
    name: 'appeals',
    description: 'Review appeals and send email replies',
    usage: '/appeals',
    staffOnly: true,
  },
  {
    name: 'staffhelp',
    description: 'Show staff commands and usage',
    usage: '/staffhelp',
    staffOnly: true,
  },
] as const;
export const isStaffCommand = (text: string) =>
  STAFF_COMMANDS.some(
    (c) => text.split(/\s/, 1)[0]?.toLowerCase() === `/${c.name}`,
  );
const card = (title: string, description: string): YapperReply => ({
  content: null,
  embeds: [
    {
      title,
      description: description.slice(0, 4096),
      color: '#8b7cff',
      fields: [],
    },
  ],
});
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Check the actual audience, including inherited channel members, on every use. */
async function allowed(
  app: FastifyInstance,
  actorId: string,
  conversationId: string,
  botId: string,
) {
  const [actor] =
    await app.sql`select id from users where id = ${actorId} and is_staff
    and deleted_at is null and (suspended_until is null or suspended_until <= now())`;
  if (!actor) return false;
  let ctx;
  try {
    ctx = await requireMember(app.db, conversationId, actorId);
  } catch {
    return false;
  }
  const c = ctx.conversation;
  if (
    c.type !== 'dm' &&
    !['staff_reports', 'staff_general', 'staff_gitlog', 'staff_bugs'].includes(
      c.systemKey ?? '',
    )
  )
    return false;
  if (c.isPublic) return false;
  const members =
    await app.sql`select m.user_id, u.is_staff from conversation_members m
    join users u on u.id = m.user_id where m.conversation_id in (${conversationId}, ${c.parentId ?? conversationId}) and m.left_at is null`;
  if (c.type === 'dm')
    return (
      members.length === 2 &&
      members.some((m) => m.user_id === botId) &&
      members.some((m) => m.user_id === actorId)
    );
  return members.every((m) => m.user_id === botId || m.is_staff);
}

async function findCase(app: FastifyInstance, reference: string) {
  if (/^SUP-[0-9a-f]{12}$/i.test(reference)) {
    const [ticket] =
      await app.sql`select t.*, u.username as verified_username from support_tickets t
      left join users u on u.id = t.verified_user_id where t.reference = ${reference.toUpperCase()}`;
    return ticket ? { kind: 'ticket' as const, row: ticket } : null;
  }
  if (!uuid.test(reference) && !/^[0-9a-f]{8}$/i.test(reference)) return null;
  const matches =
    await app.sql`select * from reports where id::text like ${reference.toLowerCase() + '%'} limit 2`;
  return matches.length === 1
    ? { kind: 'report' as const, row: matches[0]! }
    : null;
}

async function caseCard(
  app: FastifyInstance,
  reference: string,
  note: string,
  actorId: string,
) {
  const found = await findCase(app, reference);
  if (!found)
    return card(
      'Case not found',
      'Use the full SUP- reference, report UUID, or a unique 8-character report reference.',
    );
  const { kind, row } = found;
  if (note) {
    if (note.length > 2000)
      return card(
        'Note too long',
        'Keep private staff notes under 2,000 characters.',
      );
    await app.sql.begin(async (tx) => {
      await tx`insert into staff_case_notes (report_id, ticket_id, staff_id, body)
        values (${kind === 'report' ? row.id : null}, ${kind === 'ticket' ? row.id : null}, ${actorId}, ${note})`;
      await tx`insert into audit_log (id, user_id, action, metadata) values (${randomUUID()}, ${actorId}, 'staff.case_note', ${JSON.stringify({ reference })}::jsonb)`;
    });
  }
  const notes =
    await app.sql`select n.body, n.created_at, u.username from staff_case_notes n left join users u on u.id = n.staff_id
    where n.report_id = ${kind === 'report' ? row.id : null} or n.ticket_id = ${kind === 'ticket' ? row.id : null}
    order by n.created_at desc limit 5`;
  const reply =
    kind === 'ticket'
      ? card(
          row.reference,
          `Status: ${row.status} · ${row.category}\nReply address: ${row.contact_email} (requester supplied)\nVerified account: ${row.verified_username ? '@' + row.verified_username : 'No verified link'}\nAccount supplied: ${row.account_hint ?? 'None'}\nReport: ${row.report_id ?? 'None'}\n\n${String(row.message).slice(0, 2700)}\n\n/appeals reply ${row.reference} <message>\n/appeals close ${row.reference}`,
        )
      : card(
          `Case ${row.id}`,
          `Status: ${row.status}\nTarget: ${row.target_type} ${row.target_id}\nReason: ${row.reason}\n\n${String(row.detail ?? '').slice(0, 1800)}\n\nResolution: ${row.resolution ?? 'Pending'}\nEvidence: ${JSON.stringify(row.evidence ?? {}).slice(0, 1400)}`,
        );
  // Keep the whole support submission readable, even at the form's 6,000-character limit.
  if (kind === 'ticket' && String(row.message).length > 2700) {
    reply.embeds!.push({
      fields: [],
      title: 'Request continued',
      description: String(row.message).slice(2700),
    });
  }
  if (kind === 'ticket') {
    const replies =
      await app.sql`select r.body, r.created_at, r.email_job_id, u.username, j.state as delivery_state
      from support_ticket_replies r left join users u on u.id = r.staff_id
      left join pgboss.job j on j.id = r.email_job_id
      where r.ticket_id = ${row.id} order by r.created_at desc limit 3`;
    for (const r of replies)
      reply.embeds!.push({
        fields: [],
        title: `Reply · ${r.username ?? 'Former staff'}`,
        description: `${new Date(r.created_at).toISOString()} · Email queue: ${r.delivery_state ?? 'Archived; delivery not tracked'}\n\n${String(r.body).slice(0, 3600)}`,
      });
  } else {
    const actions =
      await app.sql`select action, reason, created_at from moderation_actions where report_id = ${row.id} order by created_at desc limit 5`;
    if (actions.length)
      reply.embeds!.push({
        fields: [],
        title: 'Moderation history',
        description: actions
          .map(
            (a) =>
              `${new Date(a.created_at).toISOString()} · ${a.action}\n${a.reason ?? ''}`,
          )
          .join('\n\n')
          .slice(0, 4096),
      });
  }
  if (notes.length)
    reply.embeds!.push({
      fields: [],
      title: 'Private staff notes',
      description: notes
        .map(
          (n) =>
            `${n.username ?? 'Former staff'} · ${new Date(n.created_at).toISOString()}\n${n.body}`,
        )
        .join('\n\n')
        .slice(0, 4096),
    });
  return reply;
}

async function preview(
  app: FastifyInstance,
  actorId: string,
  conversationId: string,
  kind: string,
  data: Record<string, string | number>,
  description: string,
) {
  const id = randomUUID();
  await app.sql`insert into staff_command_drafts (id, actor_id, conversation_id, kind, data)
    values (${id}, ${actorId}, ${conversationId}, ${kind}, ${JSON.stringify(data)}::jsonb)`;
  const result = card(
    kind === 'reply' ? 'Review support email' : `Review ${kind}`,
    `${description}\n\nExpires in 15 minutes. Nothing happens until you confirm.`,
  );
  result.components = [
    {
      type: 'row',
      components: [
        {
          type: 'button',
          disabled: false,
          style: kind === 'suspend' ? 'danger' : 'primary',
          label: kind === 'reply' ? 'Send reply' : 'Confirm',
          customId: `staffcmd:confirm:${id}`,
          staffOnly: true,
          onlyUserId: actorId,
        },
        {
          type: 'button',
          disabled: false,
          style: 'secondary',
          label: 'Cancel',
          customId: `staffcmd:cancel:${id}`,
          staffOnly: true,
          onlyUserId: actorId,
        },
      ],
    },
  ];
  return result;
}

export async function handleStaffCommand(
  app: FastifyInstance,
  input: { senderId: string; conversationId: string; content: string },
  botId: string,
  commandList: ReadonlyArray<{
    name: string;
    description: string;
    staffOnly?: boolean;
  }>,
): Promise<YapperReply | null> {
  if (!(await allowed(app, input.senderId, input.conversationId, botId)))
    return null;
  const [command, ...args] = input.content.trim().split(/\s+/);
  switch (command!.toLowerCase()) {
    case '/staffhelp':
      return card(
        'Staff commands',
        [
          '/health — service and queue snapshot',
          '/case REF — details and history',
          '/case REF note TEXT — private note',
          '/suspend @user 7d REASON — timed suspension (1–365 days)',
          '/warn @user REASON — official warning',
          '/appeals [open|replied|closed|all] [page] — appeal queue',
          '/appeals reply SUP-… MESSAGE — review an email reply',
          '/appeals close SUP-… — close a request',
          '/appeals reopen SUP-… — reopen a request',
          '',
          'Other staff commands:',
          ...commandList
            .filter(
              (c) =>
                c.staffOnly && !STAFF_COMMANDS.some((s) => s.name === c.name),
            )
            .map((c) => `/${c.name} — ${c.description}`),
          '',
          'Use a private Yapper DM or a staff-only system channel. Email replies never automatically change account access.',
        ].join('\n'),
      );
    case '/health': {
      const start = Date.now();
      await app.sql`select 1`;
      const dbTime = Date.now() - start;
      const [storage, queue] = await Promise.allSettled([
        new Storage().checkHealth(),
        app.sql`select name, count(*) filter (where state = 'created')::int waiting,
          count(*) filter (where state = 'active')::int active,
          count(*) filter (where state = 'failed' and created_on > now() - interval '1 hour')::int failed
          from pgboss.job group by name order by name limit 12`,
      ]);
      if (storage.status === 'rejected')
        app.log.warn(
          { err: storage.reason },
          'staff health storage probe failed',
        );
      if (queue.status === 'rejected')
        app.log.warn({ err: queue.reason }, 'staff health queue query failed');
      return card(
        'Service health',
        `API: responding · uptime ${Math.floor(process.uptime() / 60)} minutes\nDatabase: OK (${dbTime} ms)\nUploads: ${storage.status === 'fulfilled' ? 'private storage write/read/delete OK' : 'storage check failed — inspect server logs'}\n\nJob queues:\n${queue.status === 'fulfilled' ? queue.value.map((q) => `${q.name}: ${q.waiting} waiting · ${q.active} active · ${q.failed} failed in last hour`).join('\n') || 'No queued jobs' : 'Unavailable'}\n\nQueue counts are a snapshot, not a worker heartbeat. SMTP delivery is not tested here.`,
      );
    }
    case '/case': {
      if (args.length > 1 && args[1] !== 'note')
        return card('Case usage', '/case REF or /case REF note TEXT');
      return caseCard(
        app,
        args[0] ?? '',
        args.slice(2).join(' '),
        input.senderId,
      );
    }
    case '/appeals': {
      if (args[0] === 'reply') {
        const found = await findCase(app, args[1] ?? '');
        if (found?.kind !== 'ticket')
          return card('Request not found', 'Use /appeals reply SUP-… MESSAGE.');
        const body = input.content
          .trim()
          .replace(/^\/appeals\s+reply\s+\S+\s*/i, '')
          .trim();
        if (!body || body.length > 3000)
          return card(
            'Reply needed',
            'Write a reply between 1 and 3,000 characters.',
          );
        if (!env.SUPPORT_EMAIL)
          return card(
            'Email unavailable',
            'Configure SUPPORT_EMAIL before sending replies.',
          );
        return preview(
          app,
          input.senderId,
          input.conversationId,
          'reply',
          { ticketId: found.row.id, body, recipient: found.row.contact_email },
          `Request: ${found.row.reference}\nTo: ${found.row.contact_email} (requester supplied)\nReplies return to: ${env.SUPPORT_EMAIL}\n\n${body}\n\nDo not disclose private account details unless ownership has been verified.`,
        );
      }
      if (args[0] === 'close' || args[0] === 'reopen') {
        const found = await findCase(app, args[1] ?? '');
        if (found?.kind !== 'ticket')
          return card('Request not found', 'Use a full SUP- reference.');
        const status = args[0] === 'close' ? 'closed' : 'open';
        await app.sql.begin(async (tx) => {
          await tx`update support_tickets set status = ${status} where id = ${found.row.id}`;
          await tx`insert into audit_log (id, user_id, action, metadata) values (${randomUUID()}, ${input.senderId}, 'support.status', ${JSON.stringify({ reference: found.row.reference, status })}::jsonb)`;
        });
        return card(
          found.row.reference,
          `Request ${status}. No email was sent and account access has not changed.`,
        );
      }
      const status = args[0] ?? 'open';
      const page = Number(args[1] ?? 1);
      if (
        !['open', 'replied', 'closed', 'all'].includes(status) ||
        !Number.isInteger(page) ||
        page < 1 ||
        page > 10000
      )
        return card(
          'Appeals usage',
          '/appeals [open|replied|closed|all] [page]',
        );
      const tickets =
        await app.sql`select reference, status, created_at, verified_user_id from support_tickets
        where category = 'appeal' and (${status} = 'all' or status = ${status}) order by created_at, id limit 11 offset ${(page - 1) * 10}`;
      return card(
        `Appeals · ${status} · page ${page}`,
        tickets.length
          ? tickets
              .slice(0, 10)
              .map(
                (t) =>
                  `${t.reference} · ${t.status} · ${new Date(t.created_at).toISOString().slice(0, 10)}\n${t.verified_user_id ? 'Linked appeal' : 'No verified account link'} · /case ${t.reference}`,
              )
              .join('\n\n') +
              (tickets.length > 10
                ? `\n\nNext: /appeals ${status} ${page + 1}`
                : '')
          : 'No requests on this page.',
      );
    }
    case '/warn':
    case '/suspend': {
      const kind = command!.toLowerCase().slice(1);
      const days =
        kind === 'suspend' && /^\d+d$/.test(args[1] ?? '')
          ? Number(args[1]!.slice(0, -1))
          : 0;
      const reason = args.slice(kind === 'suspend' ? 2 : 1).join(' ');
      if (
        !reason ||
        reason.length > 1500 ||
        (kind === 'suspend' && (days < 1 || days > 365))
      )
        return card(
          'Command usage',
          `/${kind} @user ${kind === 'suspend' ? '7d ' : ''}REASON\nUse 1–365 days and a reason under 1,500 characters.`,
        );
      const [target] =
        await app.sql`select id, username, is_staff, is_bot, suspended_until from users where lower(username) = ${(args[0] ?? '').replace(/^@/, '').toLowerCase()} and deleted_at is null`;
      if (
        !target ||
        target.is_staff ||
        target.is_bot ||
        target.id === input.senderId
      )
        return card(
          'Account unavailable',
          'Choose an active, non-staff human account.',
        );
      if (
        kind === 'suspend' &&
        target.suspended_until &&
        new Date(target.suspended_until) > new Date()
      )
        return card(
          'Already suspended',
          'Review the existing case before changing this suspension.',
        );
      return preview(
        app,
        input.senderId,
        input.conversationId,
        kind,
        { targetId: target.id, reason, days },
        `Account: @${target.username}\n${kind === 'suspend' ? `Duration: ${days} days\nAll sessions will be revoked.\n` : 'An official in-app warning will be sent.\n'}Reason shown to user: ${reason}`,
      );
    }
    default:
      return null;
  }
}

export async function handleStaffInteraction(
  app: FastifyInstance,
  input: {
    actorId: string;
    conversationId: string;
    botId: string;
    customId: string;
  },
): Promise<InteractionResponse | null> {
  if (!(await allowed(app, input.actorId, input.conversationId, input.botId)))
    return null;
  const [, action, id] = input.customId.split(':');
  if (!id || !uuid.test(id) || !['confirm', 'cancel'].includes(action ?? ''))
    return null;
  const result = await app.sql.begin(async (tx) => {
    const [draft] =
      await tx`select * from staff_command_drafts where id = ${id} and actor_id = ${input.actorId}
      and conversation_id = ${input.conversationId} for update`;
    if (!draft) return { message: 'This confirmation is unavailable.' };
    // Recheck after acquiring the draft lock: a concurrent confirmation may
    // have kept this transaction waiting while staff access was revoked.
    const [actor] =
      await tx`select id from users where id = ${input.actorId} and is_staff
      and deleted_at is null and (suspended_until is null or suspended_until <= now()) for share`;
    if (!actor) return { message: 'Staff access is no longer available.' };
    if (draft.state === 'confirmed')
      return { message: 'Already confirmed. No duplicate action was taken.' };
    if (draft.state === 'cancelled' || new Date(draft.expires_at) <= new Date())
      return {
        message:
          'This confirmation was cancelled or expired. Run the command again.',
      };
    if (action === 'cancel') {
      if (draft.state === 'prepared')
        return {
          message: 'This action has already started. Check /case ' + id,
        };
      await tx`update staff_command_drafts set state = 'cancelled' where id = ${id}`;
      return { message: 'Cancelled. Nothing was sent or changed.' };
    }
    const data = draft.data;
    if (draft.kind === 'reply') {
      const [ticket] =
        await tx`select * from support_tickets where id = ${data.ticketId} for update`;
      if (!ticket || ticket.contact_email !== data.recipient)
        return { message: 'The request changed. Prepare a new reply.' };
      if (!env.SUPPORT_EMAIL)
        throw new Error('Support email is not configured');
      const letter = supportReplyEmail({
        reference: ticket.reference,
        message: data.body,
        supportAddress: env.SUPPORT_EMAIL,
        from: env.SUPPORT_FROM || undefined,
      });
      const job = await app.boss.send(
        'email.send',
        { ...letter, to: ticket.contact_email },
        {
          retryLimit: 10,
          retryBackoff: true,
          expireInSeconds: 3600,
          db: {
            executeSql: async (text, parameters) => ({
              rows: await tx.unsafe(
                text,
                parameters?.map((value) =>
                  value !== null && typeof value === 'object'
                    ? JSON.stringify(value)
                    : value,
                ),
              ),
            }),
          },
        },
      );
      if (!job) throw new Error('Reply email was not queued');
      await tx`insert into support_ticket_replies (id, ticket_id, staff_id, body, recipient, email_job_id)
        values (${id}, ${ticket.id}, ${input.actorId}, ${data.body}, ${ticket.contact_email}, ${job})`;
      await tx`update support_tickets set status = 'replied' where id = ${ticket.id}`;
      await tx`update staff_command_drafts set state = 'confirmed' where id = ${id}`;
      await tx`insert into audit_log (id, user_id, action, metadata) values (${randomUUID()}, ${input.actorId}, 'support.reply', ${JSON.stringify({ reference: ticket.reference, replyId: id })}::jsonb)`;
      return {
        message: `Reply queued for ${ticket.contact_email}.\nReference: ${ticket.reference}\nThey can reply by email to ${env.SUPPORT_EMAIL}. Incoming email replies arrive in that mailbox; they are not synced into Yapper.`,
      };
    }
    // A durable report makes retry after a crash safe: applyReportAction locks
    // the report and applies its moderation action at most once.
    const [target] =
      await tx`select id, is_staff, is_bot, suspended_until, deleted_at from users where id = ${data.targetId} for update`;
    if (
      draft.state === 'pending' &&
      (!target ||
        target.deleted_at ||
        target.is_staff ||
        target.is_bot ||
        (draft.kind === 'suspend' &&
          new Date(target.suspended_until) > new Date()))
    )
      return {
        message: 'The account changed. Review it and prepare a new action.',
      };
    await tx`insert into reports (id, reporter_id, target_type, target_id, reason, detail)
      values (${id}, ${input.actorId}, 'user', ${data.targetId}, 'other', ${data.reason}) on conflict (id) do nothing`;
    await tx`update staff_command_drafts set state = 'prepared' where id = ${id}`;
    return { draft };
  });
  let message = result.message;
  if ('draft' in result && result.draft) {
    const draft = result.draft;
    const outcome = await applyReportAction(app, {
      reportId: id,
      actorId: input.actorId,
      action: draft.kind,
      note: draft.data.reason,
      suspendDays: draft.data.days,
      staffCommand: true,
    });
    await app.sql`update staff_command_drafts set state = 'confirmed' where id = ${id}`;
    message = `${outcome.message}\nCase: ${id}`;
  }
  return {
    kind: 'update',
    ...card('Staff action', message ?? 'Done.'),
    components: [],
  };
}
