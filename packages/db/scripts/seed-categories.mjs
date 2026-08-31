/**
 * A space arranged into categories, for looking at.
 *
 * Builds the shape the sidebar is meant to handle: a couple of loose channels
 * at the top (where #general belongs), then dividers holding the rest —
 * including a run of ticket channels, which is the sprawl categories exist to
 * tidy away.
 *
 *   pnpm --filter @yappy/db seed-categories
 */
const API = 'http://localhost:3000/v1';

const login = async (email) => {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password: 'yappy-web-dev-2026',
      client: { platform: 'web', version: '1.0.0', device: 'seed' },
    }),
  });
  const body = await res.json();
  if (!body.accessToken) throw new Error(`login failed for ${email}: ${JSON.stringify(body)}`);
  return { token: body.accessToken, userId: body.user.id };
};
const once = async (u, method, path, payload) => {
  const res = await fetch(API + path, {
    method,
    headers: { authorization: `Bearer ${u.token}`, 'content-type': 'application/json' },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
};

/**
 * Waits out a 429 instead of dying on one.
 *
 * This seed makes eight channels in a row, which is most of the channel.create
 * bucket, so a second run inside a couple of minutes will be refused partway
 * through and leave half a space behind. The refusal says how long to wait —
 * the point of sending `retryAfter` is that a client can act on it.
 */
const call = async (u, method, path, payload, attempt = 0) => {
  const res = await once(u, method, path, payload);
  if (res.status !== 429 || attempt >= 6) return res;
  const wait = Math.min(30, res.body?.error?.retryAfter ?? 5);
  process.stdout.write(`  (rate limited, waiting ${wait}s)\n`);
  await new Promise((r) => setTimeout(r, wait * 1000));
  return call(u, method, path, payload, attempt + 1);
};

const owner = await login('webclient.test@yappy.gg');

const made = await call(owner, 'POST', '/conversations', { type: 'space', title: 'Pittsburgh' });
if (!made.body.conversation) {
  console.error(`Could not make the space (${made.status}):`, JSON.stringify(made.body));
  console.error('The conversation.create bucket refills once every 30s.');
  process.exit(1);
}
const spaceId = made.body.conversation.id;
console.log(`space ${spaceId}`);

const category = async (name) => {
  const res = await call(owner, 'POST', `/conversations/${spaceId}/categories`, { name });
  if (!res.body.category) {
    console.error(`category "${name}" failed (${res.status}):`, JSON.stringify(res.body));
    process.exit(1);
  }
  return res.body.category.id;
};
const channel = async (title, opts = {}) => {
  const res = await call(owner, 'POST', `/conversations/${spaceId}/channels`, { title, ...opts });
  if (!res.body.channel) {
    console.error(`channel "${title}" failed (${res.status}):`, JSON.stringify(res.body));
    process.exit(1);
  }
  return res.body.channel.id;
};

// Loose, above every divider — the ones you always want in reach.
await channel('general');
await channel('notices', { isAnnouncement: true });

const rooms = await category('Rooms');
await channel('design', { categoryId: rooms });
await channel('engineering', { categoryId: rooms });
await channel('lounge', { isVoice: true, categoryId: rooms });

const tickets = await category('Tickets');
for (const who of ['webclient_test2', 'boardtest', 'marks']) {
  await channel(`ticket-${who}`, { categoryId: tickets });
}

console.log('categories: Rooms, Tickets — two loose channels above them');
console.log(`open http://localhost:5173 and look at "Pittsburgh"`);
