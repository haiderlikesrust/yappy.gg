/**
 * Holding the button down.
 *
 * A bot that can create channels creates them as fast as it is asked to, and a
 * button is the easiest thing in the world to press twenty times. Channel
 * creation was the one way of making a conversation that consumed no rate
 * limit at all — so twenty rapid presses of a ticket bot's button produced
 * sixteen channels, and a space caps at LIMITS.channelsPerSpace (100). A
 * handful of bursts and a space can never make another channel: a denial of
 * service any member can perform by tapping.
 *
 * Its own script, deliberately. This *exhausts* the `conversation.create`
 * bucket on purpose, and a check that empties a budget has no business living
 * inside one that needs it — that is exactly how the first version of this
 * broke bot-install-check on every second run.
 *
 *   pnpm --filter @yappy/api channel-burst-check
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

const owner = await login('webclient.test@yappy.gg', 'burst');

const made = await call(owner, 'POST', '/conversations', {
  type: 'space',
  title: `burst ${Date.now()}`,
});
if (!made.body.conversation) {
  console.log(
    `\n  --    could not create a space (${made.status}). The conversation.create` +
      `\n        bucket is 10 deep and refills once every 30s — this script empties` +
      `\n        it by design, so give it a couple of minutes between runs.\n`,
  );
  process.exit(0);
}
const spaceId = made.body.conversation.id;

console.log('\nTwenty-five channel creations at once\n');

const burst = await Promise.all(
  Array.from({ length: 25 }, (_, i) =>
    call(owner, 'POST', `/conversations/${spaceId}/channels`, { title: `c${i}` }),
  ),
);
const accepted = burst.filter((r) => r.status < 300).length;
const refused = burst.filter((r) => r.status === 429).length;

check(
  'channel creation is rate limited',
  refused > 0,
  `${accepted} created, ${refused} refused — before this, all 25 would land`,
);
check(
  'the burst stops well short of the hundred-channel cap',
  accepted <= 18,
  `${accepted} created in one burst`,
);
check(
  'and the refusal says how long to wait',
  burst.some((r) => r.status === 429 && typeof r.body?.error?.retryAfter === 'number'),
  JSON.stringify(burst.find((r) => r.status === 429)?.body ?? {}).slice(0, 120),
);

await call(owner, 'DELETE', `/conversations/${spaceId}`);

console.log(failures === 0 ? '\n✓ a button cannot exhaust a space\n' : `\n✗ ${failures} failure(s)\n`);
process.exit(failures === 0 ? 0 : 1);
