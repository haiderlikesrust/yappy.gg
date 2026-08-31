/**
 * A space set up to exercise everything built this week, on a real device.
 *
 * Creates a space with three channels (one of them private), installs a bot
 * into it with a real grant, and posts a message carrying a `#channel`
 * signpost — so the picker, the chip, the private-channel rules and the Apps
 * screen all have something to act on.
 *
 * The account you are testing with is added as an **admin** rather than the
 * owner: admin is the interesting rank here, because it is the one that can
 * manage apps and still has something above it. The space is owned by the
 * seeded web test account.
 *
 *   pnpm --filter @yappy/db seed-bot-demo -- <email-of-the-device-account>
 *
 * Defaults to boardtest@yappy.gg, which is what the Android emulator on this
 * machine is signed in as.
 */
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { Permission } from '@yappy/shared';

const API = process.env.YAPPY_API ?? 'http://localhost:3000/v1';
const DEVICE_EMAIL = process.argv[2] ?? 'boardtest@yappy.gg';

const url =
  process.env.DATABASE_URL ??
  (await readFile(new URL('../../../.env', import.meta.url), 'utf8')).match(
    /DATABASE_URL=(.+)/,
  )?.[1]?.trim();

const sql = postgres(url, { max: 1, onnotice: () => {} });

const login = async (email, password = 'yappy-web-dev-2026') => {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      client: { platform: 'web', version: '1.0.0', device: 'seed' },
    }),
  });
  const body = await res.json();
  if (!body.accessToken) throw new Error(`login failed for ${email}: ${JSON.stringify(body)}`);
  return { token: body.accessToken, userId: body.user.id };
};

const call = async (auth, method, path, payload) => {
  const res = await fetch(API + path, {
    method,
    headers: { authorization: auth, 'content-type': 'application/json' },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (res.status >= 400) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
  return body;
};

const owner = await login('webclient.test@yappy.gg');
const asOwner = `Bearer ${owner.token}`;

const [device] = await sql`
  select id, username, display_name from users where email = ${DEVICE_EMAIL} limit 1`;
if (!device) throw new Error(`no account with email ${DEVICE_EMAIL}`);
console.log(`\nSeeding for ${device.display_name ?? device.username} (${DEVICE_EMAIL})\n`);

// ─── The space ───────────────────────────────────────────────────────────────

const stamp = new Date().toISOString().slice(11, 16).replace(':', '');
const space = (
  await call(asOwner, 'POST', '/conversations', {
    type: 'space',
    title: `Bot Playground ${stamp}`,
  })
).conversation;
console.log(`  space      ${space.title}`);

/*
 * Added straight to the membership table, which is what redeeming an invite
 * does. The device account has its own password and this script does not know
 * it, and `POST /members` would be refused anyway — the seeded accounts are
 * not contacts, so their privacy settings decline being added.
 *
 * Admin rather than member: admin is the rank that can manage apps and create
 * channels, and it still has the owner above it, so the "a bot can never touch
 * staff" rule has something to demonstrate against.
 */
await sql`
  insert into conversation_members (conversation_id, user_id, role)
  values (${space.id}, ${device.id}, 'admin')
  on conflict (conversation_id, user_id) do update set role = 'admin', left_at = null`;
console.log(`  you        added as admin`);

// ─── Channels ────────────────────────────────────────────────────────────────

const channel = async (body) =>
  (await call(asOwner, 'POST', `/conversations/${space.id}/channels`, body)).channel;

const general = await channel({ title: 'general' });
const notices = await channel({ title: 'notices', isAnnouncement: true });
const hr = await channel({ title: 'hr-only', isPrivate: true });
console.log(`  channels   #${general.title}, #${notices.title}, #${hr.title} (private)`);

// ─── The bot ─────────────────────────────────────────────────────────────────

const app = (
  await call(asOwner, 'POST', '/apps', {
    name: 'Support Bot',
    username: `supportbot${Date.now().toString().slice(-6)}`,
    description: 'Opens tickets. Installed with two bits and nothing else.',
  })
).application;

const grant = Permission.MANAGE_CONVERSATION | Permission.MANAGE_ROLES;
await call(asOwner, 'PUT', `/conversations/${space.id}/apps/${app.id}`, {
  permissions: grant.toString(10),
});
console.log(`  bot        ${app.name} — manages channels and roles`);

// ─── Something to look at ────────────────────────────────────────────────────

/*
 * A message carrying a real `#general` signpost, so the chip has something to
 * render and somewhere to go without anybody having to type it first. Offsets
 * are UTF-16 code units into `content`, which is what every client indexes by.
 */
const line = `Welcome. Announcements go in #${notices.title} — ask here and staff will open you a ticket.`;
await call(asOwner, 'POST', `/conversations/${general.id}/messages`, {
  type: 'text',
  nonce: `seed-${Date.now()}`,
  content: line,
  entities: [
    {
      // Pointing at a *different* channel, on purpose. The first version of
      // this linked #general from inside #general, which is not a signpost —
      // it is a sign pointing at itself.
      type: 'mention_channel',
      offset: line.indexOf(`#${notices.title}`),
      length: notices.title.length + 1,
      channelId: notices.id,
    },
  ],
});

await call(asOwner, 'POST', `/conversations/${hr.id}/messages`, {
  type: 'text',
  nonce: `seed-hr-${Date.now()}`,
  content: 'Only staff and people admitted to this channel can read this.',
});

await sql.end({ timeout: 5 });

console.log(`
Open the app and look for "${space.title}".

  #        type # in the composer — it offers general, notices and hr-only,
           and the chip in the welcome message opens #general on tap
  private  hr-only is visible to you because you are staff; an ordinary
           member of this space would not see it at all
  apps     group settings → Bots → Support Bot → Change cycles its grant
  tickets  the bot can open a private channel and post in it; it cannot see
           hr-only, because it was never admitted there
`);
