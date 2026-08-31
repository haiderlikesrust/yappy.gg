/**
 * What a message is allowed to claim about itself.
 *
 * Two gaps, both about entities, both fixed together because they live in the
 * same place.
 *
 * The first was an asymmetry. `send` refuses `mention_all` from anybody
 * without MENTION_ALL; `edit` wrote whatever it was handed. No notification
 * either way — an edit creates no mention rows — but every client draws the
 * chip from the entity, so posting "hi" and editing it into something that
 * looked like it called the whole room was a two-request trick.
 *
 * The second was that nothing checked an entity described the text it was
 * attached to. Offsets past the end, negative lengths and overlapping spans
 * all went straight into the column, and three clients had each grown their
 * own defence against it. Bad spans are now dropped server-side — dropped
 * rather than refused, because rejecting the send would lose somebody's
 * message over a rounding error in whichever build they happen to have.
 *
 *   pnpm --filter @yappy/api entity-guard-check
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
  return { token: body.accessToken, userId: body.user.id };
};
const call = async (u, method, path, payload) => {
  const res = await fetch(API + path, {
    method,
    headers: { authorization: `Bearer ${u.token}`, 'content-type': 'application/json' },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
};

const owner = await login('webclient.test@yappy.gg', 'entity owner');
const plain = await login('webclient.test2@yappy.gg', 'entity plain');

const space = await call(owner, 'POST', '/conversations', {
  type: 'space',
  title: `entities ${Date.now()}`,
});
const spaceId = space.body.conversation.id;
const invite = await call(owner, 'POST', `/conversations/${spaceId}/invites`, {});
await call(plain, 'POST', `/conversations/invites/${invite.body.invite?.code ?? invite.body.code}/join`, {});
const chan = await call(owner, 'POST', `/conversations/${spaceId}/channels`, {
  title: `general-${Date.now()}`,
});
const channelId = chan.body.channel.id;

const post = (who, body) =>
  call(who, 'POST', `/conversations/${channelId}/messages`, {
    type: 'text',
    nonce: `eg-${Date.now()}-${Math.trunc(performance.now())}`,
    ...body,
  });

// ─── @everyone, on both doors ────────────────────────────────────────────────

console.log('\n@everyone is refused the same way on send and on edit\n');

const everyoneSpan = (content) => [
  { type: 'mention_all', offset: 0, length: 9 },
];

const sendByPlain = await post(plain, {
  content: '@everyone look at this',
  entities: everyoneSpan(),
});
check(
  'a member without MENTION_ALL cannot send it',
  sendByPlain.status >= 400,
  `status ${sendByPlain.status}`,
);

// The bypass: post something harmless, then edit the entity in.
const innocuous = await post(plain, { content: '@everyone look at this' });
check('the same text posts fine with no entity', innocuous.status < 300,
  JSON.stringify(innocuous.body).slice(0, 160));

const sneaky = await call(
  plain,
  'PATCH',
  `/conversations/${channelId}/messages/${innocuous.body.message.id}`,
  { content: '@everyone look at this', entities: everyoneSpan() },
);
check(
  'and cannot edit it in afterwards',
  sneaky.status >= 400,
  `status ${sneaky.status} — every client draws the chip from the entity`,
);

// The owner holds MENTION_ALL, so both doors open for them.
const byOwner = await post(owner, { content: '@everyone look at this', entities: everyoneSpan() });
check('somebody who holds MENTION_ALL still can', byOwner.status < 300,
  JSON.stringify(byOwner.body).slice(0, 160));

const ownerEdit = await call(
  owner,
  'PATCH',
  `/conversations/${channelId}/messages/${byOwner.body.message.id}`,
  { content: '@everyone still here', entities: everyoneSpan() },
);
check('and can still edit their own', ownerEdit.status < 300, `status ${ownerEdit.status}`);

// ─── Spans that do not describe the text ─────────────────────────────────────

console.log('\nEntities that do not fit the message are dropped, not fatal\n');

const entitiesOf = (m) => m?.entities ?? [];

const past = await post(owner, {
  content: 'short',
  entities: [{ type: 'bold', offset: 0, length: 500 }],
});
check('a span running past the end still posts', past.status < 300, `status ${past.status}`);
check('and is dropped', entitiesOf(past.body.message).length === 0,
  JSON.stringify(entitiesOf(past.body.message)));

const negative = await post(owner, {
  content: 'hello world',
  entities: [{ type: 'bold', offset: 0, length: 5 }, { type: 'italic', offset: 2, length: 5 }],
});
check('overlapping spans still post', negative.status < 300, `status ${negative.status}`);
check(
  'and only the first survives',
  entitiesOf(negative.body.message).length === 1,
  JSON.stringify(entitiesOf(negative.body.message)),
);

const good = await post(owner, {
  content: 'hello world',
  entities: [{ type: 'bold', offset: 0, length: 5 }, { type: 'italic', offset: 6, length: 5 }],
});
check(
  'well-formed spans are untouched',
  entitiesOf(good.body.message).length === 2,
  JSON.stringify(entitiesOf(good.body.message)),
);

const exact = await post(owner, {
  content: 'edge',
  entities: [{ type: 'bold', offset: 0, length: 4 }],
});
check(
  'a span ending exactly at the last character is kept',
  entitiesOf(exact.body.message).length === 1,
  'off-by-one here would silently strip legitimate formatting',
);

await call(owner, 'DELETE', `/conversations/${spaceId}`);

console.log(failures === 0 ? '\n✓ entities describe their own message\n' : `\n✗ ${failures} failure(s)\n`);
process.exit(failures === 0 ? 0 : 1);
