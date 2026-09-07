import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// No application imports at module scope: the harness first selects an isolated DB.
export async function checkStaffCommands({ app, check }) {
  const { handleYapperMessage, handleYapperInteraction } =
    await import('../src/lib/yapper.ts');
  const { pressButton } = await import('../src/lib/interactions.ts');
  const { supportReplyEmail, resetEmail } =
    await import('../src/lib/mailer.ts');
  const { Storage } = await import('../src/lib/storage.ts');
  const { embedInput, messageComponents } = await import('@yappy/shared');
  const sql = app.sql;
  const staff = randomUUID(),
    outsider = randomUUID(),
    target = randomUUID(),
    bot = randomUUID();
  for (const [id, name, isStaff, isBot] of [
    [staff, 'command_staff', true, false],
    [outsider, 'command_outsider', false, false],
    [target, 'command_target', false, false],
    [bot, 'yapper', false, true],
  ]) {
    await sql`insert into users (id, username, display_name, email, is_staff, is_bot)
      values (${id}, ${name}, ${name}, ${name + '@example.invalid'}, ${isStaff}, ${isBot})`;
  }
  const dm = randomUUID(),
    publicChat = randomUUID();
  for (const [id, type, members] of [
    [dm, 'dm', [staff, bot]],
    [publicChat, 'group', [staff, outsider, bot]],
  ]) {
    await sql`insert into conversations (id, type, title, owner_id, dm_key) values (${id}, ${type}, 'Staff regression fixture', ${staff}, ${type === 'dm' ? members.slice().sort().join(':') : null})`;
    for (const user of members)
      await sql`insert into conversation_members (conversation_id, user_id, role) values (${id}, ${user}, 'owner')`;
  }
  const run = async (content, senderId = staff, conversationId = dm) => {
    const reply = await handleYapperMessage(app, {
      content,
      senderId,
      conversationId,
    });
    if (reply?.content?.includes('could not finish')) {
      const { handleStaffCommand } = await import('../src/lib/yapperStaff.ts');
      await handleStaffCommand(
        app,
        { content, senderId, conversationId },
        bot,
        [],
      );
      assert.fail('Staff dispatcher failed');
    }
    for (const embed of reply?.embeds ?? []) embedInput.parse(embed);
    if (reply?.components) messageComponents.parse(reply.components);
    return reply;
  };
  const text = (reply) => JSON.stringify(reply);
  const button = (preview) => preview.components[0].components[0].customId;
  const confirm = (preview, actorId = staff, conversationId = dm) =>
    handleYapperInteraction(app, {
      botId: bot,
      actorId,
      conversationId,
      messageId: randomUUID(),
      customId: button(preview),
    });
  check(
    'staff help includes new commands',
    text(await run('/staffhelp')).includes('/appeals reply'),
  );
  const staffChannel = randomUUID();
  await sql`insert into conversations (id, type, title, owner_id, system_key) values (${staffChannel}, 'group', 'Private staff', ${staff}, 'staff_bugs')`;
  for (const user of [staff, bot])
    await sql`insert into conversation_members (conversation_id, user_id, role) values (${staffChannel}, ${user}, 'owner')`;
  check(
    'staff-only system channel accepts staff commands',
    text(await run('/staffhelp', staff, staffChannel)).includes(
      '/appeals reply',
    ),
  );
  await sql`insert into conversation_members (conversation_id, user_id, role) values (${staffChannel}, ${outsider}, 'member')`;
  check(
    'staff channel refuses private output when a non-staff member can read it',
    (await run('/staffhelp', staff, staffChannel)) === null,
  );
  await sql`update conversation_members set left_at = now() where conversation_id = ${staffChannel} and user_id = ${outsider}`;
  for (const command of [
    '/staffhelp',
    '/health',
    '/appeals',
    '/case fake',
    '/warn @command_target reason',
    '/suspend @command_target 7d reason',
  ]) {
    assert.equal(await run(command, outsider, publicChat), null);
    assert.equal(await run(command, staff, publicChat), null);
  }
  check(
    'all six staff commands refuse non-staff and ordinary group contexts',
    true,
  );
  const reference = 'SUP-AABBCC112233',
    ticket = randomUUID();
  await sql`insert into support_tickets (id, reference, request_id, payload_hash, category, contact_email, account_hint, message)
    values (${ticket}, ${reference}, ${randomUUID()}, 'fixture', 'appeal', 'requester@example.invalid', 'command_target', 'Please review my suspension appeal and restore access.')`;
  check(
    'appeals list persisted requests',
    text(await run('/appeals')).includes(reference),
  );
  check(
    'case distinguishes typed account from verified ownership',
    text(await run(`/case ${reference}`)).includes('No verified link'),
  );
  const preview = await run(
    `/appeals reply ${reference} Hello <script>alert(1)</script> & welcome back.\n\nPlease reply if you need help.`,
  );
  check(
    'reply preview shows exact recipient and does not enqueue mail',
    text(preview).includes('requester@example.invalid') &&
      (await sql`select * from support_ticket_replies`).length === 0,
  );
  check(
    'another actor cannot confirm the reply',
    (await confirm(preview, outsider)) === null,
  );
  check(
    'confirmation cannot move to another conversation',
    (await confirm(preview, staff, publicChat)) === null,
  );
  await sql`update users set is_staff = false where id = ${staff}`;
  check(
    'revoked staff access prevents stale confirmation',
    (await confirm(preview)) === null,
  );
  await sql`update users set is_staff = true where id = ${staff}`;
  const originalSend = app.boss.send;
  try {
    app.boss.send = async () => {
      throw new Error('Injected email queue failure');
    };
    await assert.rejects(confirm(preview), /Injected/);
    check(
      'queue failure rolls back reply and keeps confirmation retryable',
      (await sql`select * from support_ticket_replies`).length === 0 &&
        (
          await sql`select state from staff_command_drafts where id = ${button(preview).split(':')[2]}`
        )[0].state === 'pending',
    );
  } finally {
    app.boss.send = originalSend;
  }
  await Promise.all([confirm(preview), confirm(preview)]);
  const replies =
    await sql`select * from support_ticket_replies where ticket_id = ${ticket}`;
  const [job] =
    await sql`select data from pgboss.job where id = ${replies[0].email_job_id}`;
  check(
    'simultaneous confirmation queues exactly one email and saves history',
    replies.length === 1 &&
      job.data.to === 'requester@example.invalid' &&
      job.data.replyTo === 'support@example.invalid',
  );
  check(
    'queued reply uses styled escaped HTML and plain text',
    job.data.html.includes('class="card"') &&
      job.data.html.includes('&lt;script&gt;') &&
      !job.data.html.includes('<script>') &&
      job.data.text.includes('<script>') &&
      job.data.text.includes('\n\nPlease reply'),
  );
  check(
    'reply marks ticket replied and remains visible in case history',
    (await sql`select status from support_tickets where id = ${ticket}`)[0]
      .status === 'replied' &&
      text(await run(`/case ${reference}`)).includes('Hello'),
  );
  await run(`/case ${reference} note Internal ownership review needed`);
  check(
    'private notes are saved separately from customer email',
    text(await run(`/case ${reference}`)).includes('Internal ownership') &&
      !job.data.text.includes('Internal ownership'),
  );
  await run(`/appeals close ${reference}`);
  check(
    'closed appeals leave open queue',
    !text(await run('/appeals')).includes(reference),
  );
  await run(`/appeals reopen ${reference}`);
  check(
    'appeals can be reopened',
    text(await run('/appeals')).includes(reference),
  );
  const cancelled = await run(`/appeals reply ${reference} Cancel me`);
  await handleYapperInteraction(app, {
    botId: bot,
    actorId: staff,
    conversationId: dm,
    messageId: randomUUID(),
    customId: button(cancelled).replace(':confirm:', ':cancel:'),
  });
  await confirm(cancelled);
  const expired = await run(`/appeals reply ${reference} Expire me`);
  await sql`update staff_command_drafts set expires_at = now() - interval '1 minute' where id = ${button(expired).split(':')[2]}`;
  await confirm(expired);
  check(
    'cancelled and expired previews cannot send email',
    (await sql`select * from support_ticket_replies`).length === 1,
  );
  const warn = await run(
    '/warn @command_target Please respect the community rules.',
  );
  // Exercise the actual message/button entry point, not just the helper.
  const sent = await app.messages.send(bot, dm, {
    nonce: randomUUID(),
    type: 'text',
    ...warn,
  });
  await pressButton(app, {
    actorId: staff,
    conversationId: dm,
    messageId: sent.message.id,
    customId: button(warn),
  });
  await confirm(warn);
  check(
    'warning button writes one official notification and case',
    (
      await sql`select * from notifications where user_id = ${target} and kind = 'account_warning'`
    ).length === 1 &&
      (
        await sql`select * from moderation_actions where target_id = ${target} and action = 'warn'`
      ).length === 1,
  );
  check(
    'warning leaves account access unchanged',
    (await sql`select suspended_until from users where id = ${target}`)[0]
      .suspended_until === null,
  );
  check(
    'invalid suspension durations do not create confirmation',
    !(await run('/suspend @command_target 0d reason')).components &&
      !(await run('/suspend @command_target 366d reason')).components,
  );
  check(
    'staff cannot suspend other staff',
    !(await run('/suspend @command_staff 7d reason')).components,
  );
  const { hashPassword } = await import('../src/lib/passwords.ts');
  const password = 'Staff-command-fixture-only-123!';
  await sql`update users set password_hash = ${await hashPassword(password)} where id = ${target}`;
  const login = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: {
      email: 'command_target@example.invalid',
      password,
      client: {
        platform: 'android',
        version: '2.6.0',
        device: 'Command fixture',
      },
    },
  });
  assert.equal(login.statusCode, 200, login.body);
  await sql`insert into conversation_members (conversation_id, user_id, role) values (${publicChat}, ${target}, 'member')`;
  const suspend = await run('/suspend @command_target 7d Repeated harassment');
  await confirm(suspend);
  await confirm(suspend);
  const [suspended] =
    await sql`select suspended_until, token_epoch from users where id = ${target}`;
  check(
    'confirmed suspension advances token epoch exactly once',
    suspended.token_epoch === 1 &&
      new Date(suspended.suspended_until) > new Date(),
  );
  const blocked = await app.inject({
    method: 'POST',
    url: `/v1/conversations/${publicChat}/messages`,
    headers: { authorization: `Bearer ${login.json().accessToken}` },
    payload: { nonce: randomUUID(), type: 'text', content: 'must not be sent' },
  });
  check(
    'direct staff suspension blocks old-token message sends and revokes devices',
    [401, 403].includes(blocked.statusCode) &&
      (
        await sql`select * from devices where user_id = ${target} and revoked_at is null`
      ).length === 0,
  );
  check(
    'suspension keeps a reviewable case and blocks duplicate suspension',
    text(await run(`/case ${button(suspend).split(':')[2]}`)).includes(
      'Repeated harassment',
    ) && !(await run('/suspend @command_target 7d Again')).components,
  );
  const originalHealth = Storage.prototype.checkHealth;
  try {
    Storage.prototype.checkHealth = async () => {};
    check(
      'health reports database, storage and queue limitations',
      text(await run('/health')).includes('write/read/delete OK') &&
        text(await run('/health')).includes('not a worker heartbeat'),
    );
    Storage.prototype.checkHealth = async () => {
      throw new Error('fixture storage down');
    };
    check(
      'health reports failed storage without leaking internals',
      text(await run('/health')).includes('storage check failed') &&
        !text(await run('/health')).includes('fixture storage down'),
    );
  } finally {
    Storage.prototype.checkHealth = originalHealth;
  }
  const letter = supportReplyEmail({
    reference,
    message: 'First line\nSecond line & <tag>',
    supportAddress: 'support@example.invalid',
  });
  check(
    'support email shares reset email design and preserves line breaks',
    letter.html.includes('Second line &amp; &lt;tag&gt;') &&
      letter.html.includes('<br />') &&
      letter.html.includes('class="codebox"') &&
      resetEmail('123456', 10).html.includes('class="codebox"'),
  );
}
