import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';

/** Runs only inside suspension-check's disposable database; no mail worker. */
export async function checkSupport({ app, call, check, connect, suspendedLogin, notice, userId, reportId, token, path, payload }) {
  const { env } = await import('../src/env.ts');
  const sql = app.sql;
  const resetLimits = () => sql`delete from rate_limits where action in ('support.submit', 'support.context')`;
  const ticket = (extra = {}) => ({ requestId: randomUUID(), category: 'account', email: 'requester@example.invalid',
    account: 'subject', message: 'Please help me recover access to my account.', client: 'Regression fixture', ...extra });
  const submit = data => call(null, 'POST', '/support/tickets', data);
  const config = await call(null, 'GET', '/support/config');
  check('public support form reports its configured mailbox without sign-in', config.status === 200 && config.body.available && config.body.email === 'support@example.invalid');
  const guest = ticket();
  const receipt = await submit(guest);
  assert.equal(receipt.status, 201, JSON.stringify(receipt.body));
  const reference = receipt.body.ticket.reference;
  const saved = await sql`select * from support_tickets where request_id = ${guest.requestId}`;
  const mails = await sql`select data from pgboss.job where name = 'email.send' and data->>'subject' like ${'[' + reference + ']%'}`;
  check('guest support request gets a durable ticket reference', /^SUP-[A-F0-9]{12}$/.test(reference) && saved.length === 1 && saved[0].verified_user_id === null);
  check('support mail goes only to staff with the requester as Reply-To', mails.length === 1 && mails[0].data.to === 'support@example.invalid' && mails[0].data.replyTo === guest.email && mails[0].data.text.includes('not verified'));
  const duplicate = await submit(guest);
  check('retry returns the same reference without another email', duplicate.body.ticket?.reference === reference && (await sql`select id from pgboss.job where name = 'email.send' and data->>'subject' like ${'[' + reference + ']%'}`).length === 1);
  check('request IDs cannot be reused for different content', (await submit({ ...guest, message: 'Different content reusing an earlier request ID.' })).status === 409);
  await resetLimits();
  const concurrent = ticket();
  const copies = await Promise.all([submit(concurrent), submit(concurrent)]);
  check('simultaneous retries create exactly one ticket and queued email', copies.every(c => c.status === 201) && copies[0].body.ticket.reference === copies[1].body.ticket.reference && (await sql`select id from pgboss.job where data->>'subject' like ${'[' + copies[0].body.ticket.reference + ']%'}`).length === 1);

  await resetLimits();
  const failed = ticket();
  const send = app.boss.send;
  try {
    app.boss.send = async () => { throw new Error('Injected queue failure'); };
    check('email queue failure reports failure and rolls back the ticket', (await submit(failed)).status === 500 && (await sql`select id from support_tickets where request_id = ${failed.requestId}`).length === 0);
  } finally { app.boss.send = send; }
  check('retry after a queue failure can save and deliver the same request', (await submit(failed)).status === 201);

  await resetLimits();
  for (const changes of [{ email: 'not-an-email' }, { email: 'a@example.invalid\r\nBcc: other@example.invalid' },
    { message: 'short' }, { message: 'x'.repeat(6001) }, { verifiedUserId: userId }, { category: 'admin' }]) {
    assert.equal((await submit(ticket(changes))).status, 400);
  }
  check('invalid fields, header injection and claimed verified identities are rejected', true);
  check('there is no public ticket-list endpoint', (await call(null, 'GET', '/support/tickets')).status === 404);
  const link = suspendedLogin.body.error?.details?.supportUrl;
  const appealToken = new URLSearchParams(new URL(link).hash.slice(1)).get('appeal');
  check('suspended sign-in and inbox notices include scoped appeal links', Boolean(appealToken) && Boolean(new URLSearchParams(new URL(notice.supportUrl).hash.slice(1)).get('appeal')));
  const context = await call(null, 'POST', '/support/appeal-context', { appealToken });
  check('signed-out appeal can read only its case reference and username', context.status === 200 && context.body.caseReference === reportId.slice(0, 8) && context.body.account === 'subject' && Object.keys(context.body).length === 2);
  const appeal = ticket({ category: 'appeal', appealToken, account: 'some other handle' });
  const appealReceipt = await submit(appeal);
  const [linked] = await sql`select * from support_tickets where request_id = ${appeal.requestId}`;
  check('appeal links identify the actual case regardless of typed username', appealReceipt.status === 201 && linked?.verified_user_id === userId && linked.report_id === reportId);
  check('appeal link cannot authenticate the app or developer portal', (await call(appealToken, 'GET', '/users/me')).status === 401 && (await call(appealToken, 'GET', '/portal/me')).status === 401);
  const socket = await connect(appealToken, false);
  check('appeal link cannot open a messaging socket', Boolean(socket.closeCode));
  check('filing an appeal leaves suspension and message blocking intact', (await sql`select id from users where id = ${userId} and suspended_until > now()`).length === 1 && [401, 403].includes((await call(token, 'POST', path, payload('appeal-bypass'))).status));
  check('linked appeals cannot be submitted under an unrelated category', (await submit(ticket({ appealToken }))).status === 409);

  await resetLimits();
  const expired = await new SignJWT({ typ: 'support_appeal', reportId }).setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId).setIssuer(env.JWT_ISSUER).setAudience('yappy-support').setExpirationTime(1)
    .sign(new TextEncoder().encode(env.JWT_SECRET));
  for (const invalid of ['not-a-token', token, expired, appealToken.slice(0, -8) + 'tampered']) {
    assert.equal((await call(null, 'POST', '/support/appeal-context', { appealToken: invalid })).status, 401);
    assert.equal((await submit(ticket({ category: 'appeal', appealToken: invalid }))).status, 401);
  }
  check('expired, forged and app-login tokens cannot link or submit an appeal', true);
  await resetLimits();
  check('expired-link holders can still submit an unlinked appeal', (await submit(ticket({ category: 'appeal' }))).status === 201);
  const supportEmail = env.SUPPORT_EMAIL;
  try {
    env.SUPPORT_EMAIL = '';
    check('missing mailbox disables intake instead of returning a false receipt', !(await call(null, 'GET', '/support/config')).body.available && (await submit(ticket())).status === 503);
  } finally { env.SUPPORT_EMAIL = supportEmail; }
  await resetLimits();
  for (let i = 0; i < 4; i++) assert.equal((await submit(ticket())).status, 201);
  const limited = await submit(ticket());
  check('public intake limits repeated submissions with a retry time', limited.status === 429 && limited.body.error.retryAfter > 0);
  await resetLimits();
}
