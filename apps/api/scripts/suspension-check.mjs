/**
 * Exercises the real API/services/gateway against a disposable local database.
 * Requires a local DATABASE_URL whose role can CREATE DATABASE; never uses the
 * configured database's data. No mail/push workers or real accounts are used.
 * pnpm --filter @yappy/api suspension-check
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import postgres from 'postgres';
import { checkSupport } from './support-check.mjs';
import { checkMentionPreviews } from './mention-preview-check.mjs';
import { checkCommunity } from './community-check.mjs';

const source = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(source.hostname), 'Only a local PostgreSQL server is allowed');
const databaseName = `yappy_suspension_check_${randomUUID().replaceAll('-', '')}`;
const adminUrl = new URL(source);
adminUrl.pathname = '/postgres';
const admin = postgres(adminUrl.href, { max: 1, onnotice: () => {} });
const testUrl = new URL(source);
testUrl.pathname = `/${databaseName}`;
Object.assign(process.env, {
  DATABASE_URL: testUrl.href, NODE_ENV: 'test', LOG_LEVEL: 'fatal',
  JWT_SECRET: randomUUID() + randomUUID(), HOST: '127.0.0.1', GATEWAY_PORT: '0',
  SUPPORT_EMAIL: 'support@example.invalid', OPENAI_API_KEY: '', GITHUB_WEBHOOK_SECRET: '',
  S3_ENDPOINT: 'http://127.0.0.1:1', S3_PUBLIC_BASE_URL: 'http://127.0.0.1:1',
  S3_ACCESS_KEY_ID: 'test', S3_SECRET_ACCESS_KEY: 'test',
  S3_BUCKET_MEDIA: 'test', S3_BUCKET_PUBLIC: 'test',
  LIVEKIT_URL: 'ws://127.0.0.1:1', LIVEKIT_API_KEY: 'test', LIVEKIT_API_SECRET: 'test',
});
let created = false;
let app;
let gateway;
let control;
const sockets = [];
let passed = 0;
const check = (name, condition) => {
  assert(condition, name);
  console.log(`PASS ${name}`);
  passed++;
};
const until = () => new Date(Date.now() + 86_400_000).toISOString();
const waitFor = async (predicate, message) => {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error(message);
};

try {
  await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  created = true;
  const migration = spawnSync(process.execPath, ['--import', 'tsx', '../../packages/db/src/migrate.ts'], {
    cwd: new URL('../', import.meta.url), env: process.env, encoding: 'utf8', timeout: 60_000,
  });
  assert.equal(migration.status, 0, `Test database migration failed: ${migration.stdout}\n${migration.stderr}`);
  const { buildApp } = await import('../src/app.ts');
  const { Gateway } = await import('../../gateway/src/server.ts');
  const { signAccessToken, signPortalToken, newBotToken } = await import('../src/lib/tokens.ts');
  const { hashPassword } = await import('../src/lib/passwords.ts');
  const { applyReportAction } = await import('../src/lib/staffspace.ts');
  const { issueCode } = await import('../src/lib/codes.ts');
  const { resolveBug } = await import('../src/lib/bugs.ts');
  const { forgetAuthUser } = await import('../src/plugins/auth.ts');
  const { ErrorCode, GatewayOp, CloseCode, CommandName } = await import('@yappy/shared');
  const requireGateway = createRequire(new URL('../../gateway/package.json', import.meta.url));
  const { WebSocket } = requireGateway('ws');
  app = await buildApp();
  await app.ready();
  gateway = new Gateway();
  await gateway.start();
  control = postgres(testUrl.href, { max: 2, onnotice: () => {} });
  const sql = app.sql;
  const userId = randomUUID(), ownerId = randomUUID(), reporterId = randomUUID(), botId = randomUUID();
  const password = 'Suspension-test-only-42!';
  const passwordHash = await hashPassword(password);
  for (const [id, username] of [[userId, 'subject'], [ownerId, 'moderator'], [reporterId, 'reporter'], [botId, 'testbot']]) {
    await sql`insert into users (id, username, display_name, email, password_hash, is_bot)
      values (${id}, ${username}, ${username}, ${username + '@example.invalid'}, ${passwordHash}, ${id === botId})`;
  }
  const call = async (token, method, path, payload) => {
    const res = await app.inject({ method, url: `/v1${path}`,
      headers: token ? { authorization: token.startsWith('Bot ') ? token : `Bearer ${token}` } : {},
      ...(payload ? { payload } : {}),
    });
    return { status: res.statusCode, body: res.json() };
  };
  const login = async (platform = 'android') => call(null, 'POST', '/auth/login', {
    email: 'subject@example.invalid', password, client: { platform, version: '1.0.0', device: 'Regression fixture' },
  });
  const first = await login();
  const second = await login('ios');
  check('two device sessions can sign in before suspension', first.status === 200 && second.status === 200);
  const token = first.body.accessToken;
  const { conversation } = await app.conversations.create(ownerId, {
    type: 'group', title: 'Suspension fixture', memberIds: [userId, reporterId, botId], disappearingSeconds: 0,
  });
  // New accounts default to restricting unsolicited group adds; explicitly
  // join our fixture participants rather than changing their privacy policy.
  for (const memberId of [userId, reporterId, botId]) {
    await sql`insert into conversation_members (conversation_id, user_id, role)
      values (${conversation.id}, ${memberId}, 'member') on conflict do nothing`;
  }
  const path = `/conversations/${conversation.id}/messages`;
  const payload = (content) => ({ nonce: randomUUID(), type: 'text', content });
  const before = await call(token, 'POST', path, payload('before'));
  assert([200, 201].includes(before.status), `Initial send failed: ${JSON.stringify(before)}`);
  check('ordinary message sends work before suspension', before.status === 201 || before.status === 200);
  await checkMentionPreviews({ app, sql, call, token, userId, ownerId, check });
  await checkCommunity({ app, sql, call, token, userId, ownerId, check });

  const connect = async (access, expectReady = true) => {
    const ws = new WebSocket(`ws://127.0.0.1:${gateway.http.address().port}`);
    sockets.push(ws);
    ws.frames = [];
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString());
      ws.frames.push(frame);
      if (frame.op === GatewayOp.Hello) ws.send(JSON.stringify({ op: GatewayOp.Identify, d: { token: access } }));
    });
    ws.on('close', (code) => { ws.closeCode = code; });
    ws.on('error', (error) => { ws.connectionError = error; });
    await waitFor(() => ws.frames.some(f => f.op === GatewayOp.Ready) || ws.closeCode || ws.connectionError, 'Gateway handshake timed out');
    if (expectReady) assert(ws.frames.some(f => f.op === GatewayOp.Ready), `Gateway rejected valid fixture: ${ws.closeCode}`);
    return ws;
  };
  const cachedSocket = await connect(token);
  check('authenticated WebSocket opens before suspension', cachedSocket.readyState === WebSocket.OPEN);
  await call(token, 'GET', '/users/me'); // warm this API replica's auth cache
  // Simulate another replica committing suspension without local invalidation
  // or a session event. Neither cache nor a delayed event may permit writes.
  await sql`update users set suspended_until = ${until()} where id = ${userId}`;
  const stale = await call(token, 'POST', path, payload('cached-bypass'));
  check('a warmed auth cache cannot permit a suspended write', stale.status === 403 && stale.body.error?.code === ErrorCode.AccountSuspended);
  cachedSocket.send(JSON.stringify({ op: GatewayOp.Command, nonce: 'suspended-ping', d: { c: CommandName.Ping } }));
  await waitFor(() => cachedSocket.closeCode, 'Suspended socket command was not rejected');
  check('open socket rejects commands even without a revocation event', cachedSocket.closeCode === CloseCode.SessionRevoked);
  check('suspended account cannot log in', (await login()).status === 403);
  check('suspended account cannot refresh', (await call(null, 'POST', '/auth/refresh', { refreshToken: first.body.refreshToken })).status === 403);
  const portalToken = await signPortalToken(userId);
  check('suspension also blocks developer portal access', (await call(portalToken, 'GET', '/portal/me')).status === 403);
  await assert.rejects(app.messages.send(userId, conversation.id, payload('direct-bypass')), e => e.code === ErrorCode.AccountSuspended);
  check('direct service sends cannot bypass suspension', true);
  const deniedSocket = await connect(token, false);
  check('suspended account cannot establish a new socket', !deniedSocket.frames.some(f => f.op === GatewayOp.Ready));

  await sql`update users set suspended_until = null where id = ${userId}`;
  forgetAuthUser(userId);
  // Begin a send while an uncommitted suspension owns the account row. The
  // final FOR SHARE must wait, observe the committed suspension, and reject.
  let pendingSend;
  const racePayload = payload('in-flight-bypass');
  await control.begin(async tx => {
    await tx`update users set suspended_until = ${until()} where id = ${userId}`;
    pendingSend = app.messages.send(userId, conversation.id, racePayload).then(
      value => ({ value }), error => ({ error }),
    );
    await waitFor(async () => {
      const rows = await sql`select 1 from pg_stat_activity
        where datname = ${databaseName} and wait_event_type = 'Lock'
          and query ilike '%for share%'`;
      return rows.length > 0;
    }, 'Message did not reach the final account lock');
  });
  check('in-flight send fails when suspension commits first', (await pendingSend).error?.code === ErrorCode.AccountSuspended);
  const [{ count: raceCount }] = await sql`select count(*)::int as count from messages where nonce = ${racePayload.nonce}`;
  check('rejected in-flight send leaves no message in the database', raceCount === 0);
  await sql`update users set suspended_until = null where id = ${userId}`;
  forgetAuthUser(userId);

  let pendingLogin;
  await control.begin(async tx => {
    await tx`update users set suspended_until = ${until()} where id = ${userId}`;
    pendingLogin = login();
    await waitFor(async () => (await sql`select 1 from pg_stat_activity
      where datname = ${databaseName} and wait_event_type = 'Lock' and query ilike '%for share%'`).length > 0,
    'Sign-in did not reach the final account lock');
  });
  check('sign-in already in progress cannot mint a session after suspension commits', (await pendingLogin).status === 403);
  check('rejected concurrent sign-in creates no device', (await sql`select id from devices where user_id = ${userId}`).length === 2);
  await sql`update users set suspended_until = null where id = ${userId}`;
  forgetAuthUser(userId);

  const live1 = await connect(token);
  const live2 = await connect(second.body.accessToken);
  const parked = await connect(token);
  const parkedId = parked.frames.find(f => f.op === GatewayOp.Ready).d.sessionId;
  parked.close();
  await waitFor(() => gateway.sessions.get(parkedId)?.isConnected === false, 'Fixture session was not parked');
  const reportId = randomUUID();
  await sql`insert into reports (id, reporter_id, target_type, target_id, reason)
    values (${reportId}, ${reporterId}, 'user', ${userId}, 'Regression test reason')`;
  const actions = await Promise.all([1, 2].map(() => applyReportAction(app, {
    reportId, actorId: ownerId, action: 'suspend', note: 'Regression test decision', suspendDays: 1,
  })));
  check('concurrent moderation actions apply a report only once', actions.filter(a => a.ok).length === 1);
  await waitFor(() => live1.closeCode && live2.closeCode, 'Not all suspended devices were disconnected');
  check('suspending from moderation disconnects both devices', live1.closeCode === CloseCode.SessionRevoked && live2.closeCode === CloseCode.SessionRevoked);
  check('suspension removes parked sessions from the resume pool', !gateway.sessions.has(parkedId));
  check('suspension reason reaches the active client before the socket closes', [live1, live2].every(ws => ws.frames.some(f => f.t === 'session.update' && f.d.reason === 'account_suspended' && f.d.notice.body === 'Regression test decision')));
  const sessions = await sql`select revoked_at, refresh_token_hash, previous_refresh_token_hash from devices where user_id = ${userId}`;
  check('suspension revokes all devices and clears both refresh hashes', sessions.length >= 2 && sessions.every(s => s.revoked_at && !s.refresh_token_hash && !s.previous_refresh_token_hash));
  check('old access token cannot send after moderation suspension', [401, 403].includes((await call(token, 'POST', path, payload('revoked-bypass'))).status));
  check('old refresh token cannot revive a revoked device', (await call(null, 'POST', '/auth/refresh', { refreshToken: second.body.refreshToken })).status === 401);
  const suspendedLogin = await login();
  check('sign-in explains the suspension reason and expiry even when the user was offline', suspendedLogin.body.error?.code === ErrorCode.AccountSuspended && suspendedLogin.body.error.message.includes('Regression test decision') && suspendedLogin.body.error.message.includes('GMT'));
  const notices = await sql`select kind, data from notifications where user_id = ${userId} and kind = 'account_suspended'`;
  const [{ suspended_until: deadline, token_epoch: epoch }] = await sql`select suspended_until, token_epoch from users where id = ${userId}`;
  check('one suspension notice records the actual reason and deadline', notices.length === 1 && notices[0].data.body === 'Regression test decision' && new Date(notices[0].data.until).getTime() === new Date(deadline).getTime() && epoch === 1);
  const reporterNotices = await sql`select data from notifications where user_id = ${reporterId} and kind = 'report_reviewed'`;
  check('reporter receives one review notice without the decision or moderator identity', reporterNotices.length === 1 && !JSON.stringify(reporterNotices[0]).includes('Regression test decision') && !JSON.stringify(reporterNotices[0]).includes(ownerId));

  await checkSupport({ app, call, check, connect, suspendedLogin, notice: notices[0].data, userId, reportId, token, path, payload });
  if (process.env.SUPPORT_BROWSER_CHECK === '1') {
    const { checkSupportBrowser } = await import('./support-browser-check.mjs');
    await checkSupportBrowser({ app, sql, appealUrl: notices[0].data.supportUrl, check });
  }

  // Expiry/restoration permits a fresh login, never resurrecting old devices.
  await sql`update users set suspended_until = now() - interval '1 second' where id = ${userId}`;
  forgetAuthUser(userId);
  const restored = await login();
  check('fresh login works after suspension expires', restored.status === 200);
  check('restored account can send again', (await call(restored.body.accessToken, 'POST', path, payload('after-expiry'))).status === before.status);
  check('expired suspension does not revive old credentials', (await call(token, 'POST', path, payload('old-session-after-expiry'))).status === 401);
  const inbox = await call(restored.body.accessToken, 'GET', '/social/notifications');
  check('suspension notice is available in the inbox after access resumes', inbox.status === 200 && inbox.body.notifications.some(n => n.kind === 'account_suspended'));

  // A signed token still has to identify a device belonging to its subject.
  const wrongDevice = await signAccessToken(ownerId, restored.body.deviceId, 0);
  check('access token cannot borrow another account device', (await call(wrongDevice, 'POST', path, payload('wrong-device'))).status === 401);
  const missingDevice = await signAccessToken(ownerId, randomUUID(), 0);
  check('access token cannot omit its database device', (await call(missingDevice, 'POST', path, payload('missing-device'))).status === 401);
  const bot = newBotToken();
  const applicationId = randomUUID();
  await sql`insert into applications (id, owner_id, bot_user_id, name, token_hash, token_prefix)
    values (${applicationId}, ${ownerId}, ${botId}, 'Test bot', ${bot.hash}, ${bot.prefix})`;
  await sql`update users set suspended_until = ${until()} where id = ${botId}`;
  check('bot authentication cannot bypass suspension', (await call(`Bot ${bot.token}`, 'POST', path, payload('bot-bypass'))).status === 403);
  const botSocket = await connect(bot.token, false);
  check('suspended bot cannot open a gateway session', !botSocket.frames.some(f => f.op === GatewayOp.Ready));

  await sql`update users set suspended_until = ${until()} where id = ${userId}`;
  const recoveryCode = await issueCode(app.db, 'subject@example.invalid', 'password.reset', '127.0.0.1');
  const deviceCount = (await sql`select id from devices where user_id = ${userId}`).length;
  const recovery = await call(null, 'POST', '/auth/password/reset', {
    email: 'subject@example.invalid', code: recoveryCode, password,
    client: { platform: 'android', version: '1.0.0' },
  });
  check('password recovery cannot sign in a suspended account', recovery.status === 403 && !recovery.body.accessToken);
  check('password recovery creates no usable device while suspended', (await sql`select id from devices where user_id = ${userId}`).length === deviceCount);
  const sent = await sql`select id from messages where sender_id = ${userId}`;
  check('only the two permitted messages were stored across all bypass attempts', sent.length === 2);

  const ownerDevice = randomUUID();
  await sql`insert into devices (id, user_id, platform) values (${ownerDevice}, ${ownerId}, 'web')`;
  const ownerToken = await signAccessToken(ownerId, ownerDevice, 0);
  const removed = await call(ownerToken, 'DELETE', `/conversations/${conversation.id}/members/${reporterId}`);
  const again = await call(ownerToken, 'DELETE', `/conversations/${conversation.id}/members/${reporterId}`);
  check('removing an already removed member does not repeat the action', removed.body.removed === true && again.body.removed === false);
  for (const method of ['POST', 'POST', 'DELETE', 'DELETE']) {
    const ban = await call(ownerToken, method, `/conversations/${conversation.id}/bans/${reporterId}`, method === 'POST' ? { reason: 'Fixture group ban' } : undefined);
    assert.equal(ban.status, 200, `Group ban action failed: ${JSON.stringify(ban.body)}`);
  }
  const groupNotices = await sql`select kind from notifications where user_id = ${reporterId} and kind in ('group_removed', 'group_banned', 'group_unbanned')`;
  check('remove, ban and unban each produce one notice despite retries', groupNotices.length === 3 && new Set(groupNotices.map(n => n.kind)).size === 3);
  const bugId = randomUUID();
  await sql`insert into bug_reports (id, reporter_id, title, description, reference)
    values (${bugId}, ${reporterId}, 'Fixture bug', 'Test description', 'BUG-TEST')`;
  await Promise.all([1, 2].map(() => resolveBug(app, ownerId, bugId, 'fixed')));
  check('concurrent duplicate bug status updates produce one notice', (await sql`select id from notifications where user_id = ${reporterId} and kind = 'bug_updated'`).length === 1);
  check('unfamiliar device sign-in produces an inbox notice', (await sql`select id from notifications where user_id = ${userId} and kind = 'new_sign_in'`).length >= 1);
  const readA = randomUUID(), readB = randomUUID(), otherNotice = randomUUID();
  await sql`insert into notifications (id, user_id, kind) values
    (${readA}, ${ownerId}, 'account_restored'), (${readB}, ${ownerId}, 'account_restored'),
    (${otherNotice}, ${reporterId}, 'account_restored')`;
  const inboxToken = ownerToken;
  check('notification feed advertises selective read support', (await call(inboxToken, 'GET', '/social/notifications')).body.supportsSelectiveRead === true);
  await call(inboxToken, 'POST', '/social/notifications/read', { ids: [] });
  check('empty read list never clears unread notifications', (await sql`select id from notifications where id = ${readA} and read_at is null`).length === 1);
  const selectedRead = await call(inboxToken, 'POST', '/social/notifications/read', { ids: [readA, otherNotice] });
  check('selective read acknowledges only the caller’s displayed notifications', selectedRead.status === 200 &&
    (await sql`select id from notifications where id = ${readA} and read_at is not null`).length === 1 &&
    (await sql`select id from notifications where id in (${readB}, ${otherNotice}) and read_at is null`).length === 2);
  check('notification read rejects malformed IDs', (await call(inboxToken, 'POST', '/social/notifications/read', { ids: ['invalid'] })).status === 400);
  await call(inboxToken, 'POST', '/social/notifications/read');
  check('existing mobile mark-all-read remains compatible and scoped to its account',
    (await sql`select id from notifications where id = ${readB} and read_at is not null`).length === 1 &&
    (await sql`select id from notifications where id = ${otherNotice} and read_at is null`).length === 1);
  console.log(`\n${passed} suspension, notification and support regression checks passed.`);
} finally {
  for (const socket of sockets) socket.terminate();
  await gateway?.stop();
  await app?.close();
  await control?.end({ timeout: 5 });
  if (created) {
    assert(/^yappy_suspension_check_[a-f0-9]{32}$/.test(databaseName));
    await admin.unsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  }
  await admin.end({ timeout: 5 });
}
