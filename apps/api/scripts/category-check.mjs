/**
 * Categories: dividers that group channels without becoming a second parent.
 *
 * The design rests on one claim — a category is a label, not a container — and
 * the properties worth checking are the ones that claim buys:
 *
 *   • a category never decides who can see anything, so deleting one keeps its
 *     channels (they go loose) rather than taking them down with it;
 *   • a category's *name* is still a leak, so a viewer only hears about the
 *     ones they can see a channel in — "Layoffs" holding two private channels
 *     must not announce itself to the space;
 *   • but a manager sees empty ones, because the empty category you just made
 *     is the one you are about to file channels into;
 *   • a category from another space cannot be borrowed, which would file a
 *     channel into a list it is never drawn in.
 *
 *   pnpm --filter @yappy/api category-check
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

/**
 * Categories and channels share the channel.create bucket, and this script
 * makes eight of them. Stopping with a sentence beats a TypeError twenty
 * lines later on `.category.id` of undefined.
 */
const orBail = (res, what) => {
  if (res.status === 429) {
    console.log(
      `\n  --    rate limited making ${what}. Categories and channels share one` +
        `\n        bucket (12 deep, one back every 10s) and this script spends` +
        `\n        most of it. Give it two minutes between runs.\n`,
    );
    process.exit(0);
  }
  return res;
};

const owner = await login('webclient.test@yappy.gg', 'cat owner');
const mate = await login('webclient.test2@yappy.gg', 'cat mate');

const made = await call(owner, 'POST', '/conversations', {
  type: 'space',
  title: `categories ${Date.now()}`,
});
if (!made.body.conversation) {
  console.log(
    `\n  --    could not create a space (${made.status}). The conversation.create` +
      `\n        bucket refills once every 30s; give it a minute between runs.\n`,
  );
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

const channels = (u) => call(u, 'GET', `/conversations/${spaceId}/channels`);

console.log('\nFiling channels under a category\n');

const cat = orBail(
  await call(owner, 'POST', `/conversations/${spaceId}/categories`, { name: 'Support' }),
  'the first category',
);
check('a manager can make a category', cat.status === 201, JSON.stringify(cat.body).slice(0, 160));
const categoryId = cat.body.category?.id;

const denied = await call(mate, 'POST', `/conversations/${spaceId}/categories`, { name: 'Mine' });
check('an ordinary member cannot', denied.status === 403, `status=${denied.status}`);

const filed = await call(owner, 'POST', `/conversations/${spaceId}/channels`, {
  title: 'ticket-1',
  categoryId,
});
check('a channel can be created straight into one', filed.status === 201, `status=${filed.status}`);
check(
  'and the list says which one it is under',
  (await channels(owner)).body.channels?.find((c) => c.id === filed.body.channel?.id)?.categoryId ===
    categoryId,
);

const unfiled = await call(owner, 'POST', `/conversations/${spaceId}/channels`, { title: 'general' });
const loose = (await channels(owner)).body.channels?.find((c) => c.id === unfiled.body.channel?.id);
check(
  'while a channel created without one stays loose',
  loose !== undefined && loose.categoryId === null,
  `got ${JSON.stringify(loose?.categoryId)}`,
);

console.log('\nA category from somewhere else\n');

const other = await call(owner, 'POST', '/conversations', {
  type: 'space',
  title: `elsewhere ${Date.now()}`,
});
const otherCat = other.body.conversation
  ? await call(owner, 'POST', `/conversations/${other.body.conversation.id}/categories`, {
      name: 'Theirs',
    })
  : null;
if (otherCat?.body?.category) {
  const stolen = await call(owner, 'POST', `/conversations/${spaceId}/channels`, {
    title: 'borrowed',
    categoryId: otherCat.body.category.id,
  });
  check(
    "cannot be borrowed to file this space's channel",
    stolen.status === 404,
    `status=${stolen.status} — such a channel is drawn in no list at all`,
  );
} else {
  console.log('  --    skipped (rate limited); needs a second space');
}

console.log('\nA name is a leak too\n');

const secret = await call(owner, 'POST', `/conversations/${spaceId}/categories`, {
  name: 'Layoffs',
});
const secretId = secret.body.category?.id;
await call(owner, 'POST', `/conversations/${spaceId}/channels`, {
  title: 'severance-plans',
  isPrivate: true,
  categoryId: secretId,
});

const asMate = await channels(mate);
const mateSees = (asMate.body.categories ?? []).map((c) => c.name);
check(
  'a member is not told about a category they can see nothing in',
  !mateSees.includes('Layoffs'),
  `they were offered: ${JSON.stringify(mateSees)}`,
);
check(
  'but is told about one holding a channel they can see',
  mateSees.includes('Support'),
  JSON.stringify(mateSees),
);

const emptied = orBail(
  await call(owner, 'POST', `/conversations/${spaceId}/categories`, { name: 'Empty' }),
  'the empty category',
);
check(
  'a manager sees an empty category — the one they are about to fill',
  ((await channels(owner)).body.categories ?? []).some((c) => c.name === 'Empty'),
);
check(
  'a member does not',
  !((await channels(mate)).body.categories ?? []).some((c) => c.name === 'Empty'),
);

console.log('\nDeleting a divider keeps the rooms\n');

const before = (await channels(owner)).body.channels?.length ?? 0;
const removed = await call(owner, 'DELETE', `/conversations/${spaceId}/categories/${categoryId}`);
check('the category goes', removed.status === 200, `status=${removed.status}`);

const after = await channels(owner);
check(
  'every channel survives it',
  (after.body.channels?.length ?? 0) === before,
  `${before} before, ${after.body.channels?.length} after`,
);
check(
  'and the one that was filed under it falls back to loose',
  after.body.channels?.find((c) => c.id === filed.body.channel?.id)?.categoryId === null,
);
check(
  'the category is gone from the list as well',
  !(after.body.categories ?? []).some((c) => c.id === categoryId),
);

console.log('\nMoving a channel is part of the reorder\n');

const all = (await channels(owner)).body.channels ?? [];
const target = all.find((c) => c.title === 'ticket-1');
const moved = await call(owner, 'PUT', `/conversations/${spaceId}/channels/order`, {
  channelIds: all.map((c) => c.id),
  categories: { [target.id]: emptied.body.category.id },
});
check('a drag files and sorts in one call', moved.status === 200, `status=${moved.status}`);
check(
  'and it lands where it was dropped',
  (await channels(owner)).body.channels?.find((c) => c.id === target.id)?.categoryId ===
    emptied.body.category.id,
);

const bogus = await call(owner, 'PUT', `/conversations/${spaceId}/channels/order`, {
  channelIds: all.map((c) => c.id),
  categories: { [target.id]: secretId },
});
check(
  'moving into a category of this space is fine',
  bogus.status === 200,
  `status=${bogus.status}`,
);

await call(owner, 'DELETE', `/conversations/${spaceId}`);
if (other.body.conversation) await call(owner, 'DELETE', `/conversations/${other.body.conversation.id}`);

console.log(
  failures === 0 ? '\n✓ a label, not a container\n' : `\n✗ ${failures} failure(s)\n`,
);
process.exit(failures === 0 ? 0 : 1);
