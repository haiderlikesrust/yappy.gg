/**
 * A bot with exactly the rights it was given, and no ladder promotion.
 *
 * The problem this exists to prove solved: a bot added to a space landed as an
 * ordinary member, and every interesting thing it might do needed
 * MANAGE_CONVERSATION or MANAGE_ROLES. The only way to give it those was to
 * move it up the member ladder to moderator or admin — which also handed it
 * kick, mute and delete-any-message. A bot that opens support tickets does not
 * need to be able to ban people.
 *
 * So the two halves checked here are: the grant WORKS (a ladder-`member` bot
 * really can create a channel and hand out a role), and the grant is a CEILING
 * (it cannot exceed its installer, cannot reach staff, and cannot be
 * administrator — not even if the owner asks).
 *
 *   pnpm --filter @yappy/api bot-install-check
 */
import postgres from 'postgres';
import { readFile } from 'node:fs/promises';
import { Permission, newId } from '@yappy/shared';

const API = 'http://localhost:3000/v1';
const url = (await readFile(new URL('../../../.env', import.meta.url), 'utf8')).match(
  /DATABASE_URL=(.+)/,
)[1].trim();
const sql = postgres(url, { max: 1, onnotice: () => {} });

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

const call = async (auth, method, path, payload) => {
  const res = await fetch(API + path, {
    method,
    headers: { authorization: auth, 'content-type': 'application/json' },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
};
const asUser = (u) => `Bearer ${u.token}`;
const asBot = (t) => `Bot ${t}`;

const owner = await login('webclient.test@yappy.gg', 'install owner');
const mate = await login('webclient.test2@yappy.gg', 'install mate');

// ─── A space, a bot, and a plain member to act on ────────────────────────────

const made = await call(asUser(owner), 'POST', '/conversations', {
  type: 'space',
  title: `install ${Date.now()}`,
});
if (!made.body.conversation) {
  // Almost always the conversation.create rate limit, which channel-burst-check
  // empties on purpose. A TypeError here told nobody that.
  console.error(`could not create the fixture space (${made.status}):`, JSON.stringify(made.body));
  process.exit(1);
}
const spaceId = made.body.conversation.id;

const invite = await call(asUser(owner), 'POST', `/conversations/${spaceId}/invites`, {});
await call(asUser(mate), 'POST', `/conversations/invites/${invite.body.invite?.code ?? invite.body.code}/join`, {});

const app = await call(asUser(owner), 'POST', '/apps', {
  name: `installer-${Date.now()}`,
  username: `installbot_${Date.now()}`,
});
if (!app.body.application) {
  // Minting a bot spends a conversation.create token, same as founding a
  // group. Repeated runs of this script exhaust it before anything is wrong.
  console.error(`could not create the fixture bot (${app.status}):`, JSON.stringify(app.body));
  process.exit(1);
}
const applicationId = app.body.application.id;
const botToken = app.body.token;
check('bot created', Boolean(applicationId && botToken), JSON.stringify(app.body).slice(0, 200));

// ─── Before the install: the bot can do nothing ──────────────────────────────

console.log('\nBefore installing\n');

const beforeChannel = await call(asBot(botToken), 'POST', `/conversations/${spaceId}/channels`, {
  title: 'should-not-exist',
});
check('an uninstalled bot cannot create a channel', beforeChannel.status >= 400,
  `status ${beforeChannel.status}`);

// ─── The install ─────────────────────────────────────────────────────────────

console.log('\nInstalling with two bits\n');

const grant = (Permission.MANAGE_CONVERSATION | Permission.MANAGE_ROLES).toString();
const installed = await call(asUser(owner), 'PUT', `/conversations/${spaceId}/apps/${applicationId}`, {
  permissions: grant,
});
check('install accepted', installed.status < 300, JSON.stringify(installed.body).slice(0, 200));

const listed = await call(asUser(mate), 'GET', `/conversations/${spaceId}/apps`);
const entry = (listed.body.apps ?? []).find((a) => a.applicationId === applicationId);
check('any member can see what the bot may do', Boolean(entry),
  JSON.stringify(listed.body).slice(0, 200));
check('and it lists exactly the granted bits',
  entry?.permissionNames?.includes('MANAGE_ROLES') && entry?.permissionNames?.includes('MANAGE_CONVERSATION'));

const [botRow] = await sql`
  select role::text as role from conversation_members cm
    join applications a on a.bot_user_id = cm.user_id
   where cm.conversation_id = ${spaceId} and a.id = ${applicationId}`;
check('the bot is still ladder role "member", not promoted', botRow?.role === 'member',
  `role=${botRow?.role}`);

// ─── The grant works ─────────────────────────────────────────────────────────

console.log('\nWhat the grant buys\n');

const madeChannel = await call(asBot(botToken), 'POST', `/conversations/${spaceId}/channels`, {
  title: `bot-made-${Date.now()}`,
});
check('the bot can create any channel', madeChannel.status < 300,
  JSON.stringify(madeChannel.body).slice(0, 200));

const madePrivate = await call(asBot(botToken), 'POST', `/conversations/${spaceId}/channels`, {
  title: `bot-ticket-${Date.now()}`,
  isPrivate: true,
  members: [mate.userId],
});
const ticketId = madePrivate.body.channel?.id;
check('and a private one with somebody let in', madePrivate.status < 300,
  JSON.stringify(madePrivate.body).slice(0, 200));

/*
 * Creating the room is not the job — answering in it is.
 *
 * A private channel floors ordinary members to nothing and a bot sits at
 * ladder `member` by design, so a bot holding only MANAGE_CONVERSATION built
 * a ticket channel and was then locked out of it: could not list it, could
 * not post the first message. A human owner never saw this, because the
 * ladder carries them in regardless, which is exactly why the first version
 * of this check missed it.
 */
check(
  'the bot can see the private channel it just made',
  ((await call(asBot(botToken), 'GET', `/conversations/${spaceId}/channels`)).body.channels ?? [])
    .some((c) => c.id === ticketId),
  'it built the room and could not find it',
);
const firstWord = await call(asBot(botToken), 'POST', `/conversations/${ticketId}/messages`, {
  type: 'text',
  nonce: `open-${Date.now()}`,
  content: 'How can we help?',
});
check('and post the opening message into it', firstWord.status < 300,
  JSON.stringify(firstWord.body).slice(0, 160));
check(
  'and the person it was opened for can read it',
  (await call(asUser(mate), 'GET', `/conversations/${ticketId}/messages?limit=5`)).status < 300,
);

const madeRole = await call(asBot(botToken), 'POST', `/conversations/${spaceId}/roles`, {
  name: `Ticket ${Date.now()}`,
  permissions: '0',
});
const roleId = madeRole.body.role?.id;
check('the bot can create a role', madeRole.status < 300 && Boolean(roleId),
  JSON.stringify(madeRole.body).slice(0, 200));

// The ladder relief: a `member`-rank bot assigning to a `member`-rank person.
const assigned = await call(asBot(botToken), 'PUT', `/conversations/${spaceId}/members/${mate.userId}/roles`, {
  roleIds: [roleId],
});
check('and give it to a member without outranking them', assigned.status < 300,
  JSON.stringify(assigned.body).slice(0, 200));

const removed = await call(asBot(botToken), 'PUT', `/conversations/${spaceId}/members/${mate.userId}/roles`, {
  roleIds: [],
});
check('and take it back', removed.status < 300, JSON.stringify(removed.body).slice(0, 200));

// ─── The grant is a ceiling ──────────────────────────────────────────────────

console.log('\nWhat the grant does not buy\n');

const kick = await call(asBot(botToken), 'DELETE', `/conversations/${spaceId}/members/${mate.userId}`);
check('it cannot kick — that bit was never granted', kick.status >= 400, `status ${kick.status}`);

// Promote the mate to moderator; the bot must lose all reach over them.
await call(asUser(owner), 'PATCH', `/conversations/${spaceId}/members/${mate.userId}`, {
  role: 'moderator',
});
const touchStaff = await call(asBot(botToken), 'PUT', `/conversations/${spaceId}/members/${mate.userId}/roles`, {
  roleIds: [roleId],
});
check('it cannot touch a moderator, grant or no grant', touchStaff.status >= 400,
  `status ${touchStaff.status} — the relief is capped at ordinary members`);

const admin = await call(asUser(owner), 'PUT', `/conversations/${spaceId}/apps/${applicationId}`, {
  permissions: Permission.ADMINISTRATOR.toString(),
});
check('even the owner cannot grant it administrator', admin.status >= 400,
  `status ${admin.status}`);

// The mate is a moderator now and lacks MANAGE_CONVERSATION, so they cannot
// install at all — and certainly cannot grant a bit they do not hold.
const byMate = await call(asUser(mate), 'PUT', `/conversations/${spaceId}/apps/${applicationId}`, {
  permissions: Permission.BAN_MEMBERS.toString(),
});
check('a moderator cannot grant a bit they do not hold', byMate.status >= 400,
  `status ${byMate.status}`);

const botInstalls = await call(asBot(botToken), 'PUT', `/conversations/${spaceId}/apps/${applicationId}`, {
  permissions: '0',
});
check('a bot cannot install a bot', botInstalls.status >= 400, `status ${botInstalls.status}`);

/*
 * The skeleton key.
 *
 * An install writes to the bot's SPACE membership row, and a per-member allow
 * at the space applies in every channel under it. For a management bit that is
 * right. For VIEW_CONVERSATION it is a way past every restriction in the
 * space — and it adds nothing otherwise, because a bot that is merely a member
 * already sees every ordinary channel from the base. The most reasonable
 * looking box on the form was the dangerous one.
 */
const hidden = await call(asUser(owner), 'POST', `/conversations/${spaceId}/channels`, {
  title: `hr-${Date.now()}`,
  isPrivate: true,
});
if (!hidden.body.channel) {
  console.error(`could not create the private fixture channel (${hidden.status}):`, JSON.stringify(hidden.body));
  process.exit(1);
}
const hiddenId = hidden.body.channel.id;
check(
  'the bot cannot see a private channel it was not admitted to',
  !((await call(asBot(botToken), 'GET', `/conversations/${spaceId}/channels`)).body.channels ?? [])
    .some((c) => c.id === hiddenId),
);
check(
  'nor read it by id',
  (await call(asBot(botToken), 'GET', `/conversations/${hiddenId}/messages?limit=5`)).status >= 400,
);
const skeletonKey = await call(asUser(owner), 'PUT', `/conversations/${spaceId}/apps/${applicationId}`, {
  permissions: (Permission.VIEW_CONVERSATION | Permission.MANAGE_CONVERSATION).toString(),
});
check(
  'and VIEW_CONVERSATION cannot be granted at install to change that',
  skeletonKey.status >= 400,
  `status ${skeletonKey.status} — it would reach past every restriction in the space`,
);


/*
 * The install applies space-wide, so it must be authorised space-wide.
 *
 * Permissions resolved on a CHANNEL include that channel's role overwrites, so
 * checking `:id` while writing to its parent would let someone handed
 * MANAGE_ROLES in one channel install a bot across the whole space.
 */
const scopeChannel = await call(asUser(owner), 'POST', `/conversations/${spaceId}/channels`, {
  title: `scope-${Date.now()}`,
});
const scopeChannelId = scopeChannel.body.channel.id;
const viaChannel = await call(asUser(mate), 'PUT', `/conversations/${scopeChannelId}/apps/${applicationId}`, {
  permissions: Permission.MANAGE_ROLES.toString(),
});
check('a channel-scoped actor cannot install space-wide', viaChannel.status >= 400,
  `status ${viaChannel.status}`);

/*
 * "No bot is an administrator" has to be an invariant, not a rule about one
 * door. The install refuses it; so must every other way of handing bits to a
 * user, or an owner could simply route around it.
 */
const adminRole = await call(asUser(owner), 'POST', `/conversations/${spaceId}/roles`, {
  name: `Admin${Date.now()}`,
  permissions: Permission.ADMINISTRATOR.toString(),
});
const botUserId = entry?.user?.id;
if (adminRole.status < 300 && botUserId) {
  const viaRole = await call(asUser(owner), 'PUT', `/conversations/${spaceId}/members/${botUserId}/roles`, {
    roleIds: [adminRole.body.role.id],
  });
  check('the owner cannot make a bot administrator via a role', viaRole.status >= 400,
    `status ${viaRole.status}`);

  const viaAllow = await call(asUser(owner), 'PATCH', `/conversations/${spaceId}/members/${botUserId}`, {
    allow: Permission.ADMINISTRATOR.toString(),
  });
  check('nor by writing allow directly', viaAllow.status >= 400, `status ${viaAllow.status}`);
} else {
  check('could create an ADMINISTRATOR role to test the bot routes', false,
    JSON.stringify(adminRole.body).slice(0, 160));
}


// ─── Uninstall ───────────────────────────────────────────────────────────────

console.log('\nUninstalling\n');

const gone = await call(asUser(owner), 'DELETE', `/conversations/${spaceId}/apps/${applicationId}`);
check('uninstall accepted', gone.status < 300, JSON.stringify(gone.body).slice(0, 200));

const afterChannel = await call(asBot(botToken), 'POST', `/conversations/${spaceId}/channels`, {
  title: 'after-uninstall',
});
check('and the bot can no longer do anything here', afterChannel.status >= 400,
  `status ${afterChannel.status}`);

// ─── Cleanup ─────────────────────────────────────────────────────────────────

await call(asUser(owner), 'DELETE', `/conversations/${spaceId}`);
await call(asUser(owner), 'DELETE', `/apps/${applicationId}`);
await sql.end({ timeout: 5 });

console.log(failures === 0 ? '\n✓ granted, bounded, revocable\n' : `\n✗ ${failures} failure(s)\n`);
process.exit(failures === 0 ? 0 : 1);
