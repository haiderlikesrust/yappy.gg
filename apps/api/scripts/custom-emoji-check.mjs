/**
 * Custom emoji inside a message, not only beside one.
 *
 * They were reaction-only: a `:name:` key the web resolved to a picture and
 * every phone drew as literal text. Now they are an entity, so `:party_parrot:`
 * in what you type is a picture too — resolved per reader, the way a channel
 * signpost is.
 *
 * The properties worth pinning are all about the *fallback*, because an id
 * that does not resolve is the ordinary case rather than an error:
 *
 *   • the shortcode stays in the message text, so a client that has never
 *     heard of this entity renders `:party_parrot:` rather than a gap;
 *   • an emoji from another group does not resolve here — a forwarded message
 *     carries its original ids, and those must never borrow a picture from a
 *     group this reader was never in;
 *   • a deleted emoji stops resolving and the text comes back;
 *   • a space's emoji resolve inside its channels, which is the scope the
 *     picker offers.
 *
 * The emoji rows are written straight to Postgres rather than uploaded.
 * Creating one through the API needs object storage, and what is under test
 * here is the entity — the lookup, its scoping, and the fallback. The upload
 * path is the ordinary media one and is untouched by any of it, so requiring
 * MinIO would buy nothing and make this unrunnable without it.
 *
 *   pnpm --filter @yappy/api custom-emoji-check
 */
import postgres from 'postgres';

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

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Run via pnpm, which loads .env.');
  process.exit(1);
}
const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
const done = async (code) => {
  await sql.end();
  process.exit(code);
};

/** An emoji row pointing at any confirmed image — nothing here renders it. */
const seedEmoji = async (conversationId, name) => {
  const [image] = await sql`select id from media where deleted_at is null limit 1`;
  if (!image) {
    console.log('\n  --    no media rows to point an emoji at; seed the database first.\n');
    await done(0);
  }
  const [row] = await sql`
    insert into custom_emojis (id, conversation_id, media_id, name, animated)
    values (gen_random_uuid(), ${conversationId}::uuid, ${image.id}::uuid, ${name}, false)
    returning id`;
  return row.id;
};

const owner = await login('webclient.test@yappy.gg', 'emoji owner');
const mate = await login('webclient.test2@yappy.gg', 'emoji mate');

const made = await call(owner, 'POST', '/conversations', {
  type: 'space',
  title: `emoji ${Date.now()}`,
});
if (!made.body.conversation) {
  console.log(`\n  --    could not create a space (${made.status}); the bucket refills slowly.\n`);
  await done(0);
}
const spaceId = made.body.conversation.id;

const invite = await call(owner, 'POST', `/conversations/${spaceId}/invites`, {});
await call(
  mate,
  'POST',
  `/conversations/invites/${invite.body.invite?.code ?? invite.body.code}/join`,
  {},
);
const channel = (
  await call(owner, 'POST', `/conversations/${spaceId}/channels`, { title: 'general' })
).body.channel;
if (!channel) {
  console.log('\n  --    could not create a channel (rate limited); try again in a minute.\n');
  await done(0);
}

console.log('\nAn emoji in what you type\n');

// On the space, deliberately: the message goes in a *channel* of it, which is
// the scope a picker offers and the one the lookup has to cover.
const emojiId = await seedEmoji(spaceId, 'party_parrot');

/*
 * The list a picker draws has to match the scope the renderer resolves.
 *
 * This asked the *channel*, and the channel used to answer with only its own
 * rows — always empty, because emoji are made on the space. So the picker in
 * the one kind of room most people type in offered nothing, and a composer
 * could not turn `:party_parrot:` into an entity. An offer the renderer will
 * not honour is worse than no offer.
 */
const offered = await call(mate, 'GET', `/conversations/${channel.id}/emojis`);
check(
  "a channel offers its space's emoji",
  (offered.body.emojis ?? []).some((e) => e.id === emojiId),
  JSON.stringify(offered.body).slice(0, 200),
);

const text = 'nice :party_parrot: work';
const sent = await call(owner, 'POST', `/conversations/${channel.id}/messages`, {
  type: 'text',
  nonce: `e-${Date.now()}`,
  content: text,
  entities: [
    {
      type: 'custom_emoji',
      offset: text.indexOf(':party_parrot:'),
      length: ':party_parrot:'.length,
      emojiId,
    },
  ],
});
check('a message can name one', sent.status === 201, JSON.stringify(sent.body).slice(0, 200));
/*
 * The POST response is built on a fast path that skips the full hydrator, so
 * without its own lookup a message you just sent carries the entity and no
 * picture — and falls back to `:party_parrot:` until something refetches.
 * Sending it looked like it had not worked. The gateway event everyone else
 * receives is built from the same payload, so this covers both.
 */
check(
  'and the sender is handed the picture immediately',
  Boolean(sent.body.message?.customEmojis?.[emojiId]?.url),
  JSON.stringify(sent.body.message?.customEmojis ?? null),
);

const read = await call(mate, 'GET', `/conversations/${channel.id}/messages?limit=5`);
const seen = (read.body.messages ?? []).find((m) => m.id === sent.body.message?.id);
check(
  "a space's emoji resolves inside its channels",
  Boolean(seen?.customEmojis?.[emojiId]?.url),
  JSON.stringify(seen?.customEmojis ?? null),
);
check('named, so a client can label it', seen?.customEmojis?.[emojiId]?.name === 'party_parrot');
check(
  'while the shortcode stays in the text',
  seen?.content === text,
  'a client that has never heard of this entity must still render :party_parrot:',
);

console.log('\nAn id from somewhere else resolves to nothing\n');

const elsewhere = await call(owner, 'POST', '/conversations', {
  type: 'group',
  title: `elsewhere ${Date.now()}`,
  memberIds: [],
});
if (elsewhere.body.conversation) {
  const strangerId = await seedEmoji(elsewhere.body.conversation.id, 'somewhere_else');
  const body = 'look :somewhere_else: here';
  const forged = await call(owner, 'POST', `/conversations/${channel.id}/messages`, {
    type: 'text',
    nonce: `f-${Date.now()}`,
    content: body,
    entities: [
      {
        type: 'custom_emoji',
        offset: body.indexOf(':somewhere_else:'),
        length: ':somewhere_else:'.length,
        emojiId: strangerId,
      },
    ],
  });
  const readBack = await call(mate, 'GET', `/conversations/${channel.id}/messages?limit=5`);
  const forgedSeen = (readBack.body.messages ?? []).find((m) => m.id === forged.body.message?.id);
  check(
    "an emoji from another group is not resolved here",
    !forgedSeen?.customEmojis?.[strangerId],
    'a forward must not borrow a picture from a group the reader is not in',
  );
  check('and it reads as the shortcode instead', forgedSeen?.content === body);
  await call(owner, 'DELETE', `/conversations/${elsewhere.body.conversation.id}`);
} else {
  console.log('  --    skipped the other-group case (rate limited)');
}

console.log('\nA deleted emoji gives the text back\n');

await sql`update custom_emojis set deleted_at = now() where id = ${emojiId}::uuid`;
const afterDelete = await call(mate, 'GET', `/conversations/${channel.id}/messages?limit=5`);
const stale = (afterDelete.body.messages ?? []).find((m) => m.id === sent.body.message?.id);
check('it stops resolving', !stale?.customEmojis?.[emojiId]);
check(
  'and the message still reads sensibly',
  stale?.content === text,
  'this is why the shortcode is worth keeping in the body',
);

await call(owner, 'DELETE', `/conversations/${spaceId}`);

console.log(
  failures === 0
    ? '\n✓ a picture when it resolves, the text when it does not\n'
    : `\n✗ ${failures} failure(s)\n`,
);
await done(failures === 0 ? 0 : 1);
