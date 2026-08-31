/**
 * A support ticket, end to end, over the real HTTP API.
 *
 * The flow this exists to prove: something clicks a button, a private channel
 * appears, exactly the right person is let into it, and a member of the space
 * who was not let in neither sees it nor hears about it — including when they
 * are named in it by somebody who can.
 *
 * That second half is the part that used to be untrue. A mention row drives a
 * badge, a push, and a readable copy of the message in the @ inbox, and the
 * fan-out that wrote those rows selected the SPACE's roster rather than the
 * channel's audience. So this checks the ping as carefully as it checks
 * the door.
 *
 * Two tickets and two seeded accounts are enough to cover both directions:
 * one ticket the other person is admitted to, one they are not.
 *
 *   pnpm --filter @yappy/api ticket-check
 */
const API = 'http://localhost:3000/v1';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const login = async (email, device) => {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password: 'yappy-web-dev-2026',
      client: { platform: 'web', version: '1.0.0', device },
    }),
  });
  const body = await res.json();
  if (!body.accessToken) throw new Error(`login failed for ${email}: ${JSON.stringify(body)}`);
  return { token: body.accessToken, userId: body.user.id };
};

const call = async (token, method, path, payload) => {
  const res = await fetch(API + path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
};

const staff = await login('webclient.test@yappy.gg', 'ticket staff');
const other = await login('webclient.test2@yappy.gg', 'ticket other');

// ─── A space they are both in ────────────────────────────────────────────────

const space = await call(staff.token, 'POST', '/conversations', {
  type: 'space',
  title: `tickets ${Date.now()}`,
});
const spaceId = space.body.conversation?.id;
check('space created', Boolean(spaceId), JSON.stringify(space.body).slice(0, 200));

// They join rather than being added: their privacy settings refuse an add
// from a non-contact, which is the same reason board-check uses an invite.
const invite = await call(staff.token, 'POST', `/conversations/${spaceId}/invites`, {});
const code = invite.body.invite?.code ?? invite.body.code;
const joined = await call(other.token, 'POST', `/conversations/invites/${code}/join`, {});
check('the other person joined the space', joined.status < 300, `status ${joined.status}`);

const channelsFor = async (who) => {
  const res = await call(who.token, 'GET', `/conversations/${spaceId}/channels`);
  return (res.body.channels ?? []).map((c) => c.id);
};
const mentionsIn = async (who, channelId) => {
  const res = await call(who.token, 'GET', '/users/me/mentions?limit=50');
  return (res.body.mentions ?? []).filter(
    (m) => (m.conversation?.id ?? m.conversationId) === channelId,
  );
};
const mention = (token, channelId, userId, content) =>
  call(token, 'POST', `/conversations/${channelId}/messages`, {
    type: 'text',
    nonce: `tk-${channelId}-${Date.now()}-${Math.trunc(performance.now())}`,
    content,
    // The picker offers every space member, so this is exactly what a client
    // would legitimately send. The server is what has to say no.
    entities: [{ type: 'mention', offset: 0, length: 4, userId }],
  });

// ─── Ticket A: they are NOT admitted ─────────────────────────────────────────

console.log('\nA ticket they were not let into\n');

const shut = await call(staff.token, 'POST', `/conversations/${spaceId}/channels`, {
  title: `ticket-shut-${Date.now()}`,
  isPrivate: true,
});
const shutId = shut.body.channel?.id;
check('private channel created in one call', shut.status < 300 && Boolean(shutId),
  JSON.stringify(shut.body).slice(0, 300));

check('staff sees it', (await channelsFor(staff)).includes(shutId));
check(
  'the other member does NOT see it',
  !(await channelsFor(other)).includes(shutId),
  'the channel list is the thing that is supposed to hide it',
);

const peek = await call(other.token, 'GET', `/conversations/${shutId}/messages?limit=10`);
check('and cannot read it by id', peek.status === 403 || peek.status === 404, `status ${peek.status}`);

const pinged = await mention(staff.token, shutId, other.userId, '@you secret ticket detail');
check('a message naming them still posts', pinged.status < 300,
  JSON.stringify(pinged.body).slice(0, 200));

const leaked = await mentionsIn(other, shutId);
check(
  'but it does NOT reach their @ inbox',
  leaked.length === 0,
  `${leaked.length} leaked — an inbox entry carries the message body`,
);

const home = await call(other.token, 'GET', '/conversations?limit=100');
const rows = home.body.conversations ?? home.body ?? [];
check('and the ticket is not on their home list', !rows.find((c) => c.id === shutId));

// ─── Ticket B: they ARE admitted ─────────────────────────────────────────────

console.log('\nA ticket opened for them\n');

const open = await call(staff.token, 'POST', `/conversations/${spaceId}/channels`, {
  title: `ticket-open-${Date.now()}`,
  isPrivate: true,
  members: [other.userId],
});
const openId = open.body.channel?.id;
check('private channel with a member grant', open.status < 300 && Boolean(openId),
  JSON.stringify(open.body).slice(0, 300));

check('they see this one', (await channelsFor(other)).includes(openId));
check('and can read it', (await call(other.token, 'GET', `/conversations/${openId}/messages?limit=10`)).status < 300);

const welcomed = await mention(staff.token, openId, other.userId, '@you your ticket is open');
check('the ticket owner is still mentionable', welcomed.status < 300,
  JSON.stringify(welcomed.body).slice(0, 200));
check('and the ping reaches their @ inbox', (await mentionsIn(other, openId)).length >= 1);

// The grant is scoped to the one channel, not to the space.
check(
  'being let into one ticket does not open the other',
  !(await channelsFor(other)).includes(shutId),
);

// ─── Cleanup ─────────────────────────────────────────────────────────────────

await call(staff.token, 'DELETE', `/conversations/${spaceId}`);

console.log(failures === 0 ? '\n✓ tickets work and stay shut\n' : `\n✗ ${failures} failure(s)\n`);
process.exit(failures === 0 ? 0 : 1);
