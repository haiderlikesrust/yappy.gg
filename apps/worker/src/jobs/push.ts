import {
  and,
  devices,
  eq,
  inArray,
  isNull,
  pushOutbox,
  sql as raw,
  uuidArray,
  type Database,
} from '@yappy/db';
import { newId, SILENT_SOUND } from '@yappy/shared';
import type { Logger } from 'pino';
import { env } from '../env.js';
import type { ApnsClient } from '../lib/apns.js';
import type { FcmClient } from '../lib/fcm.js';

/**
 * Push notifications, in two stages.
 *
 *   1. **Fan-out** decides *who* should be notified. This is the part with all
 *      the business logic — mute state, notification level, whether the user is
 *      already looking at the conversation on another device, quiet hours.
 *   2. **Delivery** takes an outbox row and talks to APNs/FCM.
 *
 * Splitting them means a provider outage retries delivery without re-running
 * the (expensive, and non-idempotent-feeling) fan-out query, and the outbox row
 * is a durable record of the decision for debugging "why did I not get a push".
 */

export interface PushDeps {
  db: Database;
  apns: ApnsClient;
  fcm: FcmClient;
  log: Logger;
}

interface FanoutJob {
  messageId: string;
  conversationId: string;
  senderId: string;
  seq: number;
  silent: boolean;
  mentionIds: string[];
}

export async function handleMessageFanout(deps: PushDeps, job: FanoutJob): Promise<void> {
  const { db, log } = deps;
  if (job.silent) return;

  const mentionSet = new Set(job.mentionIds);

  /**
   * One query decides the whole recipient list.
   *
   * The conditions, and why each is there:
   *   • not the sender
   *   • notification_level respected, with `mentions` honoured per-user
   *   • mute window respected
   *   • quiet hours respected, evaluated in the user's own timezone
   *   • **not currently connected** — a user with the app open gets the
   *     message over the WebSocket; pushing as well produces the duplicate
   *     buzz that makes people disable notifications entirely
   */
  /**
   * Membership comes from the *space* for a channel, and from the conversation
   * itself for everything else — `am` below is whichever of the two applies.
   *
   * This is not a refinement, it is the difference between working and not: a
   * channel's own member rows are created lazily, the first time someone reads
   * or writes there, so selecting recipients from them would have silently
   * skipped every space member who had not yet opened that channel. Which is
   * most of them, for a new channel.
   *
   * Preference then layers: the channel's own row wins where it exists, the
   * space's row is the default, and a mute on either side mutes. Muting a whole
   * space has to mute its channels, otherwise "mute" means nothing there.
   */
  const recipients = (await db.execute(
    raw`
    select
      am.user_id,
      coalesce(cm.notification_level, am.notification_level, 'all') as notification_level,
      u.notifications,
      u.locale,
      c.type as conversation_type,
      coalesce(c.title, '') as conversation_title,
      sender.display_name as sender_name,
      sender.username as sender_username,
      sender_avatar.object_key as sender_avatar_key,
      msg.type as message_type,
      msg.content as message_content,
      (c.message_seq - coalesce(cm.last_read_seq, 0)) as unread_count
    from conversations c
    join conversation_members am
      on am.conversation_id = coalesce(c.parent_id, c.id)
     and am.left_at is null
    left join conversation_members cm
      on cm.conversation_id = c.id and cm.user_id = am.user_id
    join messages msg on msg.id = ${job.messageId}::uuid
    left join users sender on sender.id = ${job.senderId}::uuid
    left join media sender_avatar on sender_avatar.id = sender.avatar_media_id
    join users u on u.id = am.user_id
    where c.id = ${job.conversationId}::uuid
      and am.user_id <> ${job.senderId}::uuid
      and u.deleted_at is null
      and coalesce(cm.notification_level, am.notification_level, 'all') <> 'none'
      and (am.muted_until is null or am.muted_until < now())
      and (cm.muted_until is null or cm.muted_until < now())
      and (
        coalesce(cm.notification_level, am.notification_level, 'all') = 'all'
        or am.user_id = any(${uuidArray(job.mentionIds)})
      )
      and not exists (
        select 1 from presence p
         where p.user_id = am.user_id
           and p.expires_at > now()
           and p.status = 'online'
      )
    limit 5000
  `,
  )) as unknown as Array<{
    user_id: string;
    notification_level: string;
    notifications: {
      showPreview: boolean;
      sound: string | null;
      reactions: boolean;
      quietHours: { enabled: boolean; start: string; end: string; timezone: string } | null;
    };
    conversation_type: string;
    conversation_title: string;
    sender_name: string | null;
    sender_username: string | null;
    sender_avatar_key: string | null;
    message_type: string;
    message_content: string | null;
    unread_count: number;
  }>;

  if (recipients.length === 0) return;

  const rows = recipients
    .filter((r) => !inQuietHours(r.notifications.quietHours))
    .map((r) => {
      const senderName = r.sender_name ?? r.sender_username ?? 'Someone';
      const isGroup = r.conversation_type !== 'dm';
      const isMention = mentionSet.has(r.user_id);

      // Preview suppression is a real privacy feature — the notification must
      // say nothing about the content, only that something arrived.
      const showPreview = r.notifications.showPreview;
      const bodyText = showPreview
        ? previewFor(r.message_type, r.message_content)
        : 'New message';

      return {
        id: newId(),
        userId: r.user_id,
        kind: isMention ? 'mention' : 'message',
        // Ten messages in one chat collapse into one notification.
        collapseKey: `conv:${job.conversationId}`,
        dedupeKey: `msg:${job.messageId}:${r.user_id}`,
        title: isGroup ? r.conversation_title || 'Group' : senderName,
        body: isGroup && showPreview ? `${senderName}: ${bodyText}` : bodyText,
        data: {
          type: 'message',
          conversationId: job.conversationId,
          messageId: job.messageId,
          seq: String(job.seq),
          senderId: job.senderId,
          // For Android's own renderer: MessagingStyle wants the sender and
          // the room as separate strings, where title/body have already fused
          // them ("NARF" / "Haider: hey"). The name is already in the title
          // for DMs, so nothing new is disclosed when previews are off.
          senderName,
          conversationTitle: r.conversation_title ?? '',
          isGroup: isGroup ? '1' : '0',
          /**
           * The sender's face, and the message on its own.
           *
           * Both exist for iOS's notification service extension, which restyles
           * the notification as a *communication* — the sender's name and
           * avatar, grouped by person, able to break through Focus. It needs
           * two things `title`/`body` cannot give it: an image URL, and the
           * message text unfused from the name, since "Haider" and
           * "Haider: hey" rendered together reads as a stutter.
           *
           * The avatar is a public-bucket URL (`mediaUrl` in the API's
           * serialize.ts), which is what lets an extension fetch it with no
           * credentials — it has no access to the app's keychain.
           *
           * `messagePreview` is `bodyText`, so preview suppression is already
           * applied: with previews off this says "New message", same as `body`.
           */
          ...(r.sender_avatar_key
            ? { senderAvatarUrl: `${env.S3_PUBLIC_BASE_URL}/${r.sender_avatar_key}` }
            : {}),
          messagePreview: bodyText,
        },
        badge: Math.max(0, r.unread_count),
        sound: r.notifications.sound ?? 'default',
        priority: 'high',
        // A "new message" push delivered an hour late is worse than none.
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      };
    });

  if (rows.length === 0) return;

  const inserted = await db
    .insert(pushOutbox)
    .values(rows)
    .onConflictDoNothing()
    .returning({ id: pushOutbox.id });

  log.debug({ messageId: job.messageId, count: inserted.length }, 'push fan-out');
}

/** Deliver every pending outbox row for one user, across their devices. */
export async function deliverPending(deps: PushDeps, limit = 200): Promise<number> {
  const { db, apns, fcm, log } = deps;

  // `for update skip locked` is what lets several worker processes drain the
  // outbox concurrently without handing the same row to two of them.
  const pending = (await db.execute(
    raw`
    with claimed as (
      select id from push_outbox
       where sent_at is null
         and (expires_at is null or expires_at > now())
       order by created_at
       for update skip locked
       limit ${limit}
    )
    update push_outbox o
       set attempts = o.attempts + 1
      from claimed
     where o.id = claimed.id
    returning o.*
  `,
  )) as unknown as Array<{
    id: string;
    user_id: string;
    device_id: string | null;
    kind: string;
    collapse_key: string | null;
    title: string | null;
    body: string | null;
    data: Record<string, unknown>;
    badge: number | null;
    sound: string | null;
    priority: string;
    attempts: number;
  }>;

  if (pending.length === 0) return 0;

  const userIds = [...new Set(pending.map((p) => p.user_id))];
  const targets = await db
    .select({
      id: devices.id,
      userId: devices.userId,
      platform: devices.platform,
      pushToken: devices.pushToken,
      voipToken: devices.voipToken,
    })
    .from(devices)
    .where(and(inArray(devices.userId, userIds), isNull(devices.revokedAt)));

  const byUser = new Map<string, typeof targets>();
  for (const d of targets) {
    if (!d.pushToken && !d.voipToken) continue;
    byUser.set(d.userId, [...(byUser.get(d.userId) ?? []), d]);
  }

  const deadTokens: string[] = [];
  let delivered = 0;

  await Promise.all(
    pending.map(async (row) => {
      const userDevices = (byUser.get(row.user_id) ?? []).filter(
        (d) => !row.device_id || d.id === row.device_id,
      );

      const results = await Promise.all(
        userDevices.map(async (device) => {
          const isCall = row.kind === 'call';

          if (device.platform === 'ios') {
            const token = isCall ? (device.voipToken ?? device.pushToken) : device.pushToken;
            if (!token) return false;

            const result = await apns.send({
              token,
              kind: isCall && device.voipToken ? 'voip' : 'alert',
              title: row.title ?? undefined,
              body: row.body ?? undefined,
              badge: row.badge ?? undefined,
              sound: isCall ? 'ringtone.caf' : (row.sound ?? 'default'),
              data: row.data,
              collapseId: row.collapse_key ?? undefined,
              threadId: (row.data.conversationId as string) ?? undefined,
              expiration: Math.floor(Date.now() / 1000) + 3_600,
              /**
               * Without this APNs delivers the notification directly and the
               * service extension is never invoked — no avatar, no sender
               * attribution, none of the reason the extension exists. Only for
               * messages: a call goes through CallKit and a reaction has no
               * person to attribute it to.
               */
              mutableContent: row.data.type === 'message',
            });

            if (!result.ok && result.unregistered) deadTokens.push(token);
            // A dead token is routine and handled above. Everything else is a
            // configuration problem wearing a disguise — the wrong APNs
            // environment, an unconfigured key, a topic the key is not scoped
            // to — and the reason string is the only thing that says which.
            // Dropping it meant "no notifications arrive" produced no log line
            // at all to work from.
            if (!result.ok && !result.unregistered) {
              log.warn({ reason: result.reason, retryable: result.retryable }, 'apns push failed');
            }
            return result.ok;
          }

          if (!device.pushToken) return false;
          const baseChannel = isCall ? 'calls' : row.kind === 'mention' ? 'mentions' : 'messages';
          // The channel decision (including the `_silent` variant, which is how
          // Android does per-user silence) used to be made here and baked into
          // the notification block. Data-only hands rendering to the app, so
          // the resolved channel rides along instead of the reasoning.
          const channel =
            !isCall && row.sound === SILENT_SOUND ? `${baseChannel}_silent` : baseChannel;
          const result = await fcm.send({
            token: device.pushToken,
            title: row.title ?? undefined,
            body: row.body ?? undefined,
            data: {
              ...Object.fromEntries(Object.entries(row.data).map(([k, v]) => [k, String(v)])),
              // Title and body move into data because data-only pushes have
              // nowhere else to put them. The 1.3.0 client's fallback renderer
              // reads exactly these two keys, which is what makes this safe to
              // send to every Android build in the wild.
              title: row.title ?? '',
              body: row.body ?? '',
              channel,
            },
            channelId: baseChannel,
            collapseKey: row.collapse_key ?? undefined,
            priority: 'high',
            tag: row.collapse_key ?? undefined,
            // A ring is never silenced by the message-sound preference — it is
            // a different thing being asked for.
            sound: isCall ? undefined : row.sound,
            /**
             * Everything is data-only now, not just calls.
             *
             * A notification block means the OS draws a title and two lines,
             * and that is the ceiling — no avatars, no history, no inline
             * reply. Drawing in the app unlocks MessagingStyle. The cost of
             * data-only (delivery depends on the app being allowed to run) is
             * already paid for calls, at high priority, and messengers have
             * shipped on exactly this arrangement for a decade.
             *
             * iOS is untouched: this is the FCM branch, and APNs has its own
             * path above.
             */
            dataOnly: true,
          });

          if (!result.ok && result.unregistered) deadTokens.push(device.pushToken);
          if (!result.ok && !result.unregistered) {
            log.warn({ reason: result.reason, retryable: result.retryable }, 'fcm push failed');
          }
          return result.ok;
        }),
      );

      const anyDelivered = results.some(Boolean);
      if (anyDelivered) delivered += 1;

      // Give up after five attempts rather than retrying a doomed row forever.
      if (anyDelivered || row.attempts >= 5 || userDevices.length === 0) {
        await db
          .update(pushOutbox)
          .set({ sentAt: new Date(), lastError: anyDelivered ? null : 'no_device_delivered' })
          .where(eq(pushOutbox.id, row.id));
      }
    }),
  );

  if (deadTokens.length > 0) {
    // Clearing dead tokens is not housekeeping — a stale token means every
    // future push for that device is wasted work and a retry storm.
    await db
      .update(devices)
      .set({ pushToken: null, voipToken: null })
      .where(inArray(devices.pushToken, deadTokens));
    log.info({ count: deadTokens.length }, 'cleared unregistered push tokens');
  }

  return delivered;
}

/** VoIP/high-priority push for an incoming call. */
export async function handleCallPush(
  deps: PushDeps,
  job: {
    callId: string;
    userIds: string[];
    mode: string;
    /** Older API replicas enqueue without these during a rolling deploy. */
    callerName?: string;
    conversationId?: string | null;
    expiresAt?: string;
  },
): Promise<void> {
  if (job.userIds.length === 0) return;

  await deps.db
    .insert(pushOutbox)
    .values(
      job.userIds.map((userId) => ({
        id: newId(),
        userId,
        kind: 'call',
        collapseKey: `call:${job.callId}`,
        dedupeKey: `call:${job.callId}:${userId}`,
        // The caller's name, because that is the entire question an incoming
        // call screen answers. CallKit renders straight from this payload.
        title: job.callerName ?? 'Incoming call',
        body: job.mode === 'video' ? 'Video call' : 'Voice call',
        data: {
          type: 'call',
          callId: job.callId,
          mode: job.mode,
          ...(job.callerName ? { callerName: job.callerName } : {}),
          ...(job.conversationId ? { conversationId: job.conversationId } : {}),
          ...(job.expiresAt ? { expiresAt: job.expiresAt } : {}),
        },
        priority: 'high',
        // A call push that arrives after the ring timeout is pure noise.
        expiresAt: new Date(Date.now() + 45_000),
      })),
    )
    .onConflictDoNothing();
}

export async function handleReactionPush(
  deps: PushDeps,
  job: { messageId: string; actorId: string; emoji: string },
): Promise<void> {
  const rows = (await deps.db.execute(
    raw`select msg.sender_id, msg.conversation_id, u.notifications, actor.display_name, actor.username
          from messages msg
          join users u on u.id = msg.sender_id
          left join users actor on actor.id = ${job.actorId}::uuid
         where msg.id = ${job.messageId}::uuid
           and msg.sender_id is not null
           and msg.sender_id <> ${job.actorId}::uuid`,
  )) as unknown as Array<{
    sender_id: string;
    conversation_id: string;
    notifications: { reactions: boolean };
    display_name: string | null;
    username: string | null;
  }>;

  const row = rows[0];
  if (!row || !row.notifications.reactions) return;

  await deps.db
    .insert(pushOutbox)
    .values({
      id: newId(),
      userId: row.sender_id,
      kind: 'reaction',
      // One reaction notification per message, not per reaction.
      collapseKey: `reaction:${job.messageId}`,
      dedupeKey: `reaction:${job.messageId}:${job.actorId}:${job.emoji}`,
      title: row.display_name ?? row.username ?? 'Someone',
      body: `Reacted ${job.emoji} to your message`,
      data: {
        type: 'reaction',
        conversationId: row.conversation_id,
        messageId: job.messageId,
      },
      priority: 'normal',
      expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000),
    })
    .onConflictDoNothing();
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function previewFor(type: string, content: string | null): string {
  if (content && content.trim()) return content.slice(0, 140);
  switch (type) {
    case 'image':
      return '📷 Photo';
    case 'video':
      return '🎥 Video';
    case 'audio':
      return '🎤 Voice message';
    case 'file':
      return '📎 File';
    case 'sticker':
      return 'Sticker';
    case 'gif':
      return 'GIF';
    case 'poll':
      return '📊 Poll';
    case 'location':
      return '📍 Location';
    default:
      return 'New message';
  }
}

/**
 * Quiet hours, evaluated in the user's timezone.
 *
 * Handles the wrap-around case (22:00 → 07:00) explicitly, because the naive
 * `start <= now <= end` comparison silently disables quiet hours for exactly
 * the people who set them overnight — which is everyone.
 */
function inQuietHours(quiet: { enabled: boolean; start: string; end: string; timezone: string } | null): boolean {
  if (!quiet?.enabled) return false;

  try {
    const now = new Date();
    const local = new Intl.DateTimeFormat('en-GB', {
      timeZone: quiet.timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(now);

    const [h, m] = local.split(':').map(Number);
    const minutes = (h ?? 0) * 60 + (m ?? 0);

    const toMinutes = (hhmm: string) => {
      const [hh, mm] = hhmm.split(':').map(Number);
      return (hh ?? 0) * 60 + (mm ?? 0);
    };

    const start = toMinutes(quiet.start);
    const end = toMinutes(quiet.end);

    return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
  } catch {
    // An invalid timezone must not silence someone's notifications forever.
    return false;
  }
}
