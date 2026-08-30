/**
 * A board channel, and cards addressed by name.
 *
 * The property worth checking is the one that makes a board different from a
 * chat: calling `set` a hundred times leaves one card, not a hundred messages.
 * Everything else here is the guard rail around that — a name belongs to its
 * author, a board is read-only to members, and a card that already exists is
 * not re-announced.
 *
 *   pnpm --filter @yappy/api board-check
 */
const API = 'http://localhost:3000/v1';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${name}${detail && !ok ? ` — ${detail}` : ''}`);
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

const alice = await login('webclient.test@yappy.gg', 'board owner');
const bob = await login('webclient.test2@yappy.gg', 'board member');

// ─── a space with a board in it ──────────────────────────────────────────────

const space = await call(alice.token, 'POST', '/conversations', {
  type: 'space',
  title: `board test ${Date.now() % 100000}`,
});
const spaceId = space.body.conversation.id;

// A space holds the membership; every channel in it borrows that list. Bob has
// to actually be in it for "what a member can do here" to mean anything — and
// he joins, rather than being added, because his privacy settings say so.
const invite = await call(alice.token, 'POST', `/conversations/${spaceId}/invites`, {});
const code = invite.body.invite?.code ?? invite.body.code;
const joined = await call(bob.token, 'POST', `/conversations/invites/${code}/join`, {});
check('the other person joined the space', joined.status < 300, `status ${joined.status}`);

const made = await call(alice.token, 'POST', `/conversations/${spaceId}/channels`, {
  title: 'status',
  position: 1,
  isBoard: true,
});
check('a board channel is created', made.status === 201, `status ${made.status}`);
const boardId = made.body.channel?.id ?? made.body.conversation?.id ?? made.body.id;

const channels = await call(alice.token, 'GET', `/conversations/${spaceId}/channels`);
const listed = (channels.body.channels ?? []).find((c) => c.id === boardId);
check('the space says it is a board', listed?.isBoard === true);
check('and gives it the announcement floor', listed?.isAnnouncement === true);

const opened = await call(bob.token, 'GET', `/conversations/${boardId}`);
check(
  'a member arriving at it directly can tell it is a board',
  opened.body.conversation?.isBoard === true,
);

// ─── a card, addressed by name ───────────────────────────────────────────────

const first = await call(alice.token, 'PUT', `/conversations/${boardId}/cards/sol-price`, {
  content: 'SOL — $142.10',
});
check('the first set creates the card', first.status === 201, `status ${first.status}`);
const cardId = first.body.message?.id;

const second = await call(alice.token, 'PUT', `/conversations/${boardId}/cards/sol-price`, {
  content: 'SOL — $143.55',
});
check('the second set updates rather than creates', second.status === 200, `status ${second.status}`);
check('and it is the same message', second.body.message?.id === cardId);

// The whole point: a loop leaves one card behind, not a scroll of them.
for (let i = 0; i < 5; i += 1) {
  await call(alice.token, 'PUT', `/conversations/${boardId}/cards/sol-price`, {
    content: `SOL at ${144 + i}`,
  });
}

const history = await call(alice.token, 'GET', `/conversations/${boardId}/messages?limit=50`);
const cards = (history.body.messages ?? []).filter((m) => m.type !== 'system');
check('seven sets left exactly one card', cards.length === 1, `${cards.length} messages`);
check(
  'showing what was last written to it',
  cards[0]?.content === 'SOL at 148',
  String(cards[0]?.content),
);

const other = await call(alice.token, 'PUT', `/conversations/${boardId}/cards/eth-price`, {
  content: 'ETH — $3,100',
});
check('a different name is a different card', other.body.message?.id !== cardId);

const afterTwo = await call(alice.token, 'GET', `/conversations/${boardId}/messages?limit=50`);
check(
  'and the board now holds two',
  (afterTwo.body.messages ?? []).filter((m) => m.type !== 'system').length === 2,
);

// ─── the guard rails ─────────────────────────────────────────────────────────

const asMember = await call(bob.token, 'PUT', `/conversations/${boardId}/cards/sol-price`, {
  content: 'mine now',
});
check(
  'an ordinary member cannot post to a board',
  asMember.status === 403,
  `status ${asMember.status}`,
);

const stillOurs = await call(alice.token, 'GET', `/conversations/${boardId}/messages?limit=50`);
const ours = (stillOurs.body.messages ?? []).find((m) => m.id === cardId);
check('and did not overwrite the card of that name', ours?.content === 'SOL at 148');

// Rich cards stay a bot affordance, which is a rule that predates boards and
// survives them: a person who could hand-craft an embed could forge anything a
// bot can say.
const asHuman = await call(alice.token, 'PUT', `/conversations/${boardId}/cards/rich`, {
  embeds: [{ title: 'not mine to write' }],
});
check('a person still cannot hand-craft an embed', asHuman.status === 403, `status ${asHuman.status}`);

// ─── an ordinary channel is unaffected ───────────────────────────────────────

const plain = await call(alice.token, 'POST', `/conversations/${spaceId}/channels`, {
  title: 'general',
  position: 2,
});
const plainId = plain.body.channel?.id ?? plain.body.conversation?.id ?? plain.body.id;
const plainListed = (await call(alice.token, 'GET', `/conversations/${spaceId}/channels`)).body.channels.find(
  (c) => c.id === plainId,
);
check('a normal channel is still not a board', plainListed?.isBoard === false);
check('and members can still speak in it', plainListed?.isAnnouncement === false);

console.log(failures === 0 ? '\nall green' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
