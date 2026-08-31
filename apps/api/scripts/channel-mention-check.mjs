/**
 * `#channel` signposts, and the one rule that makes them safe.
 *
 * A channel mention carries an id, and the server resolves it to a title so
 * clients can render the current name and open the room on a tap. That
 * resolution is a disclosure: handing somebody the title of a channel they
 * have no access to tells them it exists and what it is called, which is most
 * of what a private channel is hiding.
 *
 * So resolution is per READER, not per sender — the same message resolves for
 * one person and stays as plain text for another. That is the property this
 * checks, along with the ordinary case working at all.
 *
 *   pnpm --filter @yappy/api channel-mention-check
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

const staff = await login('webclient.test@yappy.gg', 'chanmention staff');
const other = await login('webclient.test2@yappy.gg', 'chanmention other');

const space = await call(staff, 'POST', '/conversations', {
  type: 'space',
  title: `signposts ${Date.now()}`,
});
const spaceId = space.body.conversation.id;
const invite = await call(staff, 'POST', `/conversations/${spaceId}/invites`, {});
await call(other, 'POST', `/conversations/invites/${invite.body.invite?.code ?? invite.body.code}/join`, {});

// A channel everybody can see, and one only staff can.
const openChan = await call(staff, 'POST', `/conversations/${spaceId}/channels`, {
  title: `lobby-${Date.now()}`,
});
const openId = openChan.body.channel.id;
const secretChan = await call(staff, 'POST', `/conversations/${spaceId}/channels`, {
  title: `secret-${Date.now()}`,
  isPrivate: true,
});
const secretId = secretChan.body.channel.id;
check('two channels created', Boolean(openId && secretId));

// ─── An ordinary signpost ────────────────────────────────────────────────────

console.log('\nA signpost both of them can follow\n');

const openTitle = openChan.body.channel.title;
const post = async (author, where, label, channelId) =>
  call(author, 'POST', `/conversations/${where}/messages`, {
    type: 'text',
    nonce: `cm-${Date.now()}-${Math.trunc(performance.now())}`,
    content: `see #${label} for details`,
    entities: [{ type: 'mention_channel', offset: 4, length: label.length + 1, channelId }],
  });

const sent = await post(staff, openId, openTitle, openId);
check('a message with a channel entity posts', sent.status < 300,
  JSON.stringify(sent.body).slice(0, 200));

const readBy = async (who, where, messageId) => {
  const res = await call(who, 'GET', `/conversations/${where}/messages?limit=20`);
  return (res.body.messages ?? []).find((m) => m.id === messageId);
};

const seenByStaff = await readBy(staff, openId, sent.body.message.id);
check('the sender sees the title resolved',
  Boolean(seenByStaff?.mentionedChannels?.[openId]?.title),
  JSON.stringify(seenByStaff?.mentionedChannels ?? null));

const seenByOther = await readBy(other, openId, sent.body.message.id);
check('and so does everybody else in the room',
  seenByOther?.mentionedChannels?.[openId]?.title === openTitle,
  JSON.stringify(seenByOther?.mentionedChannels ?? null));

// ─── A signpost to somewhere the reader cannot go ────────────────────────────

console.log('\nA signpost to a channel the reader cannot see\n');

const secretTitle = secretChan.body.channel.title;
const leak = await post(staff, openId, secretTitle, secretId);
check('the message still posts', leak.status < 300, JSON.stringify(leak.body).slice(0, 200));

const leakToStaff = await readBy(staff, openId, leak.body.message.id);
check('staff, who can see it, get the title',
  leakToStaff?.mentionedChannels?.[secretId]?.title === secretTitle,
  JSON.stringify(leakToStaff?.mentionedChannels ?? null));

const leakToOther = await readBy(other, openId, leak.body.message.id);
check(
  'the other reader gets NOTHING resolved — it renders as plain text',
  !leakToOther?.mentionedChannels?.[secretId],
  `resolving it would disclose the channel's name and existence: ${JSON.stringify(
    leakToOther?.mentionedChannels ?? null,
  )}`,
);
check('and the entity itself is still there, so the text reads normally',
  (leakToOther?.entities ?? []).some((e) => e.type === 'mention_channel'));

// ─── The picker source ───────────────────────────────────────────────────────

console.log('\nWhat the picker is allowed to offer\n');

const staffChannels = (await call(staff, 'GET', `/conversations/${spaceId}/channels`)).body.channels ?? [];
const otherChannels = (await call(other, 'GET', `/conversations/${spaceId}/channels`)).body.channels ?? [];
check('staff can pick the private channel', staffChannels.some((c) => c.id === secretId));
check('the other member cannot even see it in the list',
  !otherChannels.some((c) => c.id === secretId));
check('both can pick the open one',
  staffChannels.some((c) => c.id === openId) && otherChannels.some((c) => c.id === openId));

await call(staff, 'DELETE', `/conversations/${spaceId}`);

console.log(failures === 0 ? '\n✓ signposts point only where you can follow\n' : `\n✗ ${failures} failure(s)\n`);
process.exit(failures === 0 ? 0 : 1);
