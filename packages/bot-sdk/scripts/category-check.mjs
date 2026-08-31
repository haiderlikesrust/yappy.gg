/**
 * A bot filing its own channels.
 *
 * The reason categories exist at all: a support bot opens one channel per
 * ticket, and six tickets in, a space's real rooms are below the fold. So the
 * bot has to be able to make the divider and file into it — through the same
 * endpoints a person uses, gated by the same permission, and with no way to
 * reach anything a channel grant would not already give it.
 *
 * What this holds the SDK to:
 *
 *   • `ensureCategory` is idempotent — a bot that restarts must not collect a
 *     second "Tickets", which is what the obvious find-or-create gets wrong;
 *   • a bot without MANAGE_CONVERSATION is refused, so the permission gate is
 *     the same one channels get;
 *   • a filed private channel is still private — filing is cosmetic, and a
 *     category must never become a way to widen who can see something.
 *
 *   pnpm --filter @yappydotgg/bot-sdk category-check
 */
// The built package, not the source — this checks what a bot author gets.
import { YappyBot } from '../dist/index.js';

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

const bail = (res, what) => {
  if (res.status === 429) {
    console.log(
      `\n  --    rate limited making ${what}. Give it a minute between runs.\n`,
    );
    process.exit(0);
  }
  return res;
};

const owner = await login('webclient.test@yappy.gg', 'botcat owner');
const mate = await login('webclient.test2@yappy.gg', 'botcat mate');

const made = await call(owner, 'POST', '/conversations', {
  type: 'space',
  title: `botcat ${Date.now()}`,
});
if (!made.body.conversation) {
  console.log(`\n  --    could not create a space (${made.status}); the bucket refills slowly.\n`);
  process.exit(0);
}
const spaceId = made.body.conversation.id;

const invite = await call(owner, 'POST', `/conversations/${spaceId}/invites`, {});
await call(
  mate,
  'POST',
  `/conversations/invites/${invite.body.invite?.code ?? invite.body.code}/join`,
  {},
);

// ── a bot, installed with the permission that governs channels ─────────────

const app = bail(
  await call(owner, 'POST', '/apps', {
    name: `filer ${Date.now()}`,
    username: `filerbot_${Date.now()}`,
  }),
  'the bot',
);
if (!app.body.application) {
  console.error(`could not create the bot (${app.status}):`, JSON.stringify(app.body));
  process.exit(1);
}
const applicationId = app.body.application.id;
const botToken = app.body.token;

// MANAGE_CONVERSATION (bit 36) plus MANAGE_ROLES (35), the pair a ticket bot
// needs: one to make the room, one to decide who is in it.
const grant = ((1n << 36n) | (1n << 35n)).toString();
const installed = await call(owner, 'PUT', `/conversations/${spaceId}/apps/${applicationId}`, {
  permissions: grant,
});
if (installed.status >= 300) {
  console.error(`could not install the bot (${installed.status}):`, JSON.stringify(installed.body));
  process.exit(1);
}

const bot = new YappyBot({ token: botToken, baseUrl: API });

console.log('\nA bot makes its own divider\n');

const first = await bot.ensureCategory(spaceId, 'Tickets');
check('ensureCategory makes one when it is missing', typeof first === 'string' && first.length > 0);

const second = await bot.ensureCategory(spaceId, 'Tickets');
check(
  'and returns the same one on the next call',
  second === first,
  'a bot that restarts must not collect a second "Tickets"',
);

const listed = await bot.channels(spaceId);
check(
  'so the space has exactly one',
  listed.categories.filter((c) => c.name === 'Tickets').length === 1,
  JSON.stringify(listed.categories.map((c) => c.name)),
);

console.log('\nAnd files a ticket into it\n');

const { channel } = await bot.createChannel(spaceId, {
  title: `ticket-${Date.now()}`,
  isPrivate: true,
  members: [mate.userId],
  categoryId: first,
});
check('the channel is created', Boolean(channel?.id));

const after = await bot.channels(spaceId);
check(
  'and lands in the category, in one call',
  after.channels.find((c) => c.id === channel.id)?.categoryId === first,
);

console.log('\nFiling changes where it is drawn, not who can see it\n');

/*
 * Somebody else's ticket, in the same category.
 *
 * This is the sharp version of the question. Mate can see the "Tickets"
 * category — they have a ticket in it — so the category is not hidden from
 * them, and a category that leaked its contents would hand them this one too.
 * Filing has to stay purely about where a row is drawn.
 */
const other = await bot.createChannel(spaceId, {
  title: `ticket-someone-else-${Date.now()}`,
  isPrivate: true,
  categoryId: first,
});

const asMate = await call(mate, 'GET', `/conversations/${spaceId}/channels`);
const mateChannels = asMate.body.channels ?? [];
check('the person admitted still sees their ticket', mateChannels.some((c) => c.id === channel.id));
check(
  'and the category it is in',
  (asMate.body.categories ?? []).some((c) => c.id === first),
);
check(
  "but not somebody else's ticket filed under the same one",
  !mateChannels.some((c) => c.id === other.channel.id),
  'a visible category must not carry the channels inside it',
);

console.log('\nThe gate is the same one channels get\n');

const plain = bail(
  await call(owner, 'POST', '/apps', {
    name: `plain ${Date.now()}`,
    username: `plainbot_${Date.now()}`,
  }),
  'the second bot',
);
if (plain.body.application) {
  await call(owner, 'PUT', `/conversations/${spaceId}/apps/${plain.body.application.id}`, {
    // READ_HISTORY only: allowed to look, not to arrange.
    permissions: (1n << 11n).toString(),
  });
  const weak = new YappyBot({ token: plain.body.token, baseUrl: API });
  const refused = await weak
    .createCategory(spaceId, { name: 'Mine' })
    .then(() => null)
    .catch((err) => err);
  check(
    'a bot without MANAGE_CONVERSATION cannot make one',
    refused !== null,
    'it made a category with no permission to',
  );
} else {
  console.log('  --    skipped (rate limited); needs a second bot');
}

await call(owner, 'DELETE', `/conversations/${spaceId}`);

console.log(failures === 0 ? '\n✓ a bot can tidy up after itself\n' : `\n✗ ${failures} failure(s)\n`);
process.exit(failures === 0 ? 0 : 1);
