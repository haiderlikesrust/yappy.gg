/**
 * Developer-portal sign-in, end to end.
 *
 * The interesting assertions are the refusals. A device grant is a session
 * handed to a machine nobody has authenticated, so what matters is that it
 * cannot be obtained by guessing, by racing, by skipping the confirmation, by
 * a second person claiming someone else's code, or — now that the decision is
 * a button — by someone else pressing it.
 *
 *   node scripts/portal.mjs
 *
 * Accounts are made through the real registration endpoint. This used to
 * scrape a code out of the worker's log, which coupled the suite to a running
 * worker, to a log format, and to the OTP rate limiter — none of which are
 * under test here, and which together turned a five-second run into a
 * seven-minute one.
 */
const API = process.env.API_BASE ?? 'http://localhost:3000/v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const ok = (l, x = '') => console.log(`  ok   ${l}${x ? ' — ' + x : ''}`);
const bad = (l, d) => { failures++; console.log(`  FAIL ${l} — ${d}`); };
const expect = (l, a, w) => (a === w ? ok(l, String(a)) : bad(l, `expected ${w}, got ${a}`));

async function call(method, path, body, auth) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {} };
}

/** Errors come back as `{ error: { code, message } }`. */
const msg = (res) => res.json.error?.message ?? res.json.message ?? '';
const code = (res) => res.json.error?.code ?? '';

const CLIENT = { platform: 'web', version: '1.0.0-test' };
const PASSWORD = 'correct-horse-battery-staple';

async function signUp(handle, displayName) {
  const username = `${handle}_${Math.random().toString(36).slice(2, 10)}`;
  const res = await call('POST', '/auth/register', {
    email: `${username}@example.test`,
    password: PASSWORD,
    username,
    displayName,
    client: CLIENT,
  });
  if (res.status !== 201) throw new Error(`register failed: ${JSON.stringify(res.json)}`);
  return {
    auth: `Bearer ${res.json.accessToken}`,
    id: res.json.user.id,
    username,
    email: `${username}@example.test`,
  };
}

/**
 * Open (or reuse) the DM with yapper, send it a line, and wait for the reply
 * *to that line*.
 *
 * The seq bookkeeping is not incidental: the bot answers asynchronously, so
 * simply reading the newest message from it returns the answer to the previous
 * command and every assertion afterwards checks the wrong string.
 */
const dmCache = new Map();

/** Open the DM once per actor. Re-opening it on every line trips the
 *  conversation-creation rate limit long before the suite finishes. */
async function yapperDm(actor, yapperId) {
  const cached = dmCache.get(actor.id);
  if (cached) return cached;
  const dm = await call('POST', '/conversations', { type: 'dm', memberIds: [yapperId] }, actor.auth);
  const id = dm.json.conversation?.id;
  if (!id) throw new Error(`could not open a DM with yapper: ${JSON.stringify(dm.json)}`);
  dmCache.set(actor.id, id);
  return id;
}

async function tellYapper(actor, text, yapperId) {
  const conversationId = await yapperDm(actor, yapperId);

  const sent = await call('POST', `/conversations/${conversationId}/messages`, {
    nonce: `t_${Math.random().toString(36).slice(2)}`, type: 'text', content: text,
  }, actor.auth);
  const afterSeq = sent.json.message?.seq ?? 0;

  for (let i = 0; i < 24; i++) {
    await sleep(250);
    const hist = await call('GET', `/conversations/${conversationId}/messages?limit=10`, null, actor.auth);
    const reply = (hist.json.messages ?? [])
      .filter((m) => m.senderId === yapperId && m.seq > afterSeq)
      .sort((a, b) => a.seq - b.seq)[0];
    if (reply) return { ...reply, conversationId };
  }
  return null;
}

/** Flatten a message's buttons, which is all any assertion here cares about. */
const buttons = (message) => (message?.components ?? []).flatMap((r) => r.components ?? []);
const buttonNamed = (message, id) => buttons(message).find((b) => b.customId === id);
const embedOf = (message) => (message?.embeds ?? [])[0] ?? {};
const fieldNamed = (message, name) =>
  (embedOf(message).fields ?? []).find((f) => f.name === name)?.value;

const press = (actor, message, customId) =>
  call(
    'POST',
    `/conversations/${message.conversationId}/messages/${message.id}/interactions`,
    { customId },
    actor.auth,
  );

const stamp = String(Date.now()).slice(-7);

console.log('\n── setup ──────────────────────────────────────────');
const dev = await signUp("dev", "Developer");
const other = await signUp("other", "Someone Else");

console.log('\n── email, password, username ──────────────────────');
expect('registering signs you straight in', typeof dev.auth, 'string');

const dupEmail = await call('POST', '/auth/register', {
  email: dev.email, password: PASSWORD, username: `x_${stamp}`, client: CLIENT,
});
expect('the same email cannot register twice', dupEmail.status, 409);
expect('and says which field clashed', /email/i.test(msg(dupEmail)), true);

const dupName = await call('POST', '/auth/register', {
  email: `x_${stamp}@example.test`, password: PASSWORD, username: dev.username, client: CLIENT,
});
expect('nor can the same username', dupName.status, 409);
expect('and says so', /username/i.test(msg(dupName)), true);

const weak = await call('POST', '/auth/register', {
  email: `w_${stamp}@example.test`, password: 'short', username: `w_${stamp}`, client: CLIENT,
});
expect('a short password is refused', code(weak), 'validation_failed');
expect('naming the field', weak.json.error?.details?.[0]?.path, 'password');

const sameAsEmail = await call('POST', '/auth/register', {
  email: `s_${stamp}@example.test`,
  password: `s_${stamp}@example.test`,
  username: `s_${stamp}`,
  client: CLIENT,
});
expect('and a password equal to the email', code(sameAsEmail), 'validation_failed');

const goodLogin = await call('POST', '/auth/login', {
  email: dev.email, password: PASSWORD, client: CLIENT,
});
expect('signing in works', goodLogin.status, 200);
expect('and returns a usable token', typeof goodLogin.json.accessToken, 'string');

const badLogin = await call('POST', '/auth/login', {
  email: dev.email, password: 'not-the-password', client: CLIENT,
});
expect('a wrong password is refused', badLogin.status, 401);

const noSuchAccount = await call('POST', '/auth/login', {
  email: `ghost_${stamp}@example.test`, password: PASSWORD, client: CLIENT,
});
// Identical status *and* message: differing on either turns this endpoint
// into a way to ask whether an address has an account here.
expect('an unknown email fails the same way', noSuchAccount.status, 401);
expect('with a real message', msg(badLogin), 'Email or password is incorrect');
expect('and the identical one', msg(noSuchAccount), msg(badLogin));

const otpGone = await call('POST', '/auth/otp/request', { phone: '+15550000001' });
expect('phone sign-in is gone', otpGone.status, 404);

const found = await call('GET', '/users?q=yapper', null, dev.auth);
const yapper = found.json.users?.find((u) => u.username === 'yapper');
if (!yapper) { console.log('  FAIL yapper bot does not exist — run apps/api/scripts/create-yapper.mjs'); process.exit(1); }
ok('yapper exists', yapper.id);
expect('and is marked staff', yapper.badge, 'staff');
expect('and has the app icon as its avatar', typeof yapper.avatarUrl === 'string', true);

console.log('\n── the composer can offer its commands ────────────');
const dmForCommands = await yapperDm(dev, yapper.id);
const cmds = await call('GET', `/conversations/${dmForCommands}/commands`, null, dev.auth);
const names = (cmds.json.commands ?? []).map((c) => c.name).sort();
expect(
  'yapper publishes its commands',
  names.join(','),
  'about,apps,cancel,help,login,ping,privacy,report,status,whoami',
);
expect('each one is attributed to the bot', cmds.json.commands?.[0]?.botUsername, 'yapper');
expect('and each carries a description', (cmds.json.commands ?? []).every((c) => c.description), true);

console.log('\n── the browser asks ───────────────────────────────');
const start = await call('POST', '/portal/auth/start');
expect('grant issued', start.status, 201);
const { userCode, pollToken } = start.json;
ok('code', userCode);
expect('code is two groups of four', /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(userCode), true);

const early = await call('POST', '/portal/auth/poll', { pollToken });
expect('polling before anything happens is pending', early.json.status, 'pending');

console.log('\n── the guided flow ────────────────────────────────');
const asked = await tellYapper(dev, '/login', yapper.id);
expect('bare /login asks for the code', /Send me the code/i.test(embedOf(asked).title ?? ''), true);
expect('and offers no buttons yet', buttons(asked).length, 0);

// The point of the prompt: a bare code, with no command, is understood.
const wrong = await tellYapper(dev, 'AAAA-BBBB', yapper.id);
expect('a wrong code is refused', /not valid|expired/i.test(wrong?.content ?? ''), true);
expect('and it asks again rather than giving up', /Send another code/i.test(wrong?.content ?? ''), true);

const claimed = await tellYapper(dev, userCode, yapper.id);
expect('the right code produces a card', /Approve this sign-in/i.test(embedOf(claimed).title ?? ''), true);
expect('naming the client', typeof fieldNamed(claimed, 'Client'), 'string');
expect('and the address', typeof fieldNamed(claimed, 'Address'), 'string');
ok('client', fieldNamed(claimed, 'Client'));

expect('with two buttons', buttons(claimed).length, 2);
expect('an approve', buttonNamed(claimed, 'login:approve')?.style, 'success');
expect('and a reject', buttonNamed(claimed, 'login:deny')?.style, 'danger');
expect('both addressed to the person signing in', buttonNamed(claimed, 'login:approve')?.onlyUserId, dev.id);

const midway = await call('POST', '/portal/auth/poll', { pollToken });
expect('showing the card grants nothing', midway.json.status, 'awaiting_confirm');
expect('and hands over no token', midway.json.token, undefined);

console.log('\n── who may press ──────────────────────────────────');
// `other` is not in this DM at all, so the refusal should be about the
// conversation before it is ever about the button.
const outsider = await press(other, claimed, 'login:approve');
expect('someone outside the conversation cannot press', outsider.status >= 400, true);
ok('refused with', String(outsider.status));

const invented = await press(dev, claimed, 'login:nonsense');
expect('a made-up button id is not found', invented.status, 404);

console.log('\n── pressing approve ───────────────────────────────');
const pressed = await press(dev, claimed, 'login:approve');
expect('the press succeeds', pressed.status, 200);
expect('the card becomes an outcome', embedOf(pressed.json.message).title, 'Signed in');
expect('and the buttons are gone', buttons(pressed.json.message).length, 0);

const granted = await call('POST', '/portal/auth/poll', { pollToken });
expect('the browser gets a session', granted.json.status, 'approved');
const portalToken = granted.json.token;
expect('with a token', typeof portalToken, 'string');

console.log('\n── the press cannot be replayed ───────────────────');
const again = await press(dev, claimed, 'login:approve');
expect('pressing the retired button is refused', again.status >= 400, true);
ok('refused with', String(again.status));

console.log('\n── what the session can and cannot do ─────────────');
const who = await call('GET', '/portal/me', null, `Bearer ${portalToken}`);
expect('it identifies the developer', who.json.user?.username, dev.username);

// The whole reason for a separate token type.
const misuse = await call('GET', '/users/me', null, `Bearer ${portalToken}`);
expect('a portal token cannot call the app API', misuse.status, 401);

const reverse = await call('GET', '/portal/me', null, dev.auth);
expect('an app token cannot call the portal API', reverse.status, 401);

console.log('\n── single use ─────────────────────────────────────');
const replay = await call('POST', '/portal/auth/poll', { pollToken });
expect('the grant cannot be redeemed twice', replay.json.status, 'consumed');

console.log('\n── someone else cannot claim a code ───────────────');
const second = await call('POST', '/portal/auth/start');
await tellYapper(dev, `/login ${second.json.userCode}`, yapper.id);
const stolen = await tellYapper(other, `/login ${second.json.userCode}`, yapper.id);
expect('a second person is refused', /already signing in/i.test(stolen?.content ?? ''), true);

console.log('\n── rejecting ──────────────────────────────────────');
const third = await call('POST', '/portal/auth/start');
const toReject = await tellYapper(dev, `/login ${third.json.userCode}`, yapper.id);
const rejected = await press(dev, toReject, 'login:deny');
expect('the card says so', embedOf(rejected.json.message).title, 'Rejected');
const deniedPoll = await call('POST', '/portal/auth/poll', { pollToken: third.json.pollToken });
expect('and the browser is told', deniedPoll.json.status, 'denied');

console.log('\n── getting out of a prompt ────────────────────────');
await tellYapper(dev, '/login', yapper.id);
const cancelled = await tellYapper(dev, '/cancel', yapper.id);
expect('/cancel abandons the question', /Cancelled/i.test(cancelled?.content ?? ''), true);
// And afterwards an ordinary sentence is an ordinary sentence again.
const ignored = await tellYapper(dev, 'just talking to myself', yapper.id);
expect('so a plain message is no longer read as a code', ignored, null);

console.log('\n── people cannot forge any of this ────────────────');
const forgeDm = await call('POST', '/conversations', { type: 'dm', memberIds: [other.id] }, dev.auth);
const forged = await call('POST', `/conversations/${forgeDm.json.conversation.id}/messages`, {
  nonce: `forge_${stamp}`,
  type: 'text',
  content: 'Verify your account',
  components: [{ type: 'row', components: [{ type: 'button', customId: 'x', label: 'Verify', style: 'primary' }] }],
}, dev.auth);
expect('a person cannot attach buttons', forged.status, 403);
ok('refused with', forged.json.message ?? forged.json.error?.message ?? '');

console.log('\n── yapper is not a group member ───────────────────');
// It answers commands in a DM and nowhere else, so being addable to a group
// would only ever produce confusion or a place to try commands in front of an
// audience. Enforced by its own privacy setting, not a special case.
const group = await call('POST', '/conversations', {
  type: 'group', title: `With a bot ${stamp}`, memberIds: [],
}, dev.auth);
const groupId = group.json.conversation.id;
const addBot = await call('POST', `/conversations/${groupId}/members`, {
  userIds: [yapper.id],
}, dev.auth);
// Adding members is a partial-success endpoint: one refusal reports itself in
// `skipped` rather than failing the whole request, so the assertion is about
// the outcome for yapper rather than the status code.
expect('the request itself succeeds', addBot.status, 200);
expect(
  'but yapper is skipped',
  addBot.json.skipped?.some((s) => s.userId === yapper.id),
  true,
);
const after = await call('GET', `/conversations/${groupId}`, null, dev.auth);
expect('and it is not in the group', after.json.conversation?.memberCount, 1);

console.log('\n── it is more than a login bot ────────────────────');
const whoami = await tellYapper(dev, '/whoami', yapper.id);
expect('/whoami reports the account', embedOf(whoami).description, `@${dev.username}`);
expect('with the user id', fieldNamed(whoami, 'User ID'), dev.id);

const status = await tellYapper(dev, '/status', yapper.id);
expect('/status measures the database', /responded in \d+ ms/.test(fieldNamed(status, 'Database') ?? ''), true);

const apps = await tellYapper(dev, '/apps', yapper.id);
expect('/apps is honest when there are none', embedOf(apps).title, 'You have not built a bot yet');
expect('and says how to make one', /developer portal/i.test(embedOf(apps).description ?? ''), true);

const about = await tellYapper(dev, '/about', yapper.id);
expect('/about describes yappy', embedOf(about).title, 'yappy');

console.log('\n── /privacy changes a real setting ────────────────');
const privacy = await tellYapper(dev, '/privacy', yapper.id);
expect('it reports the current audience', fieldNamed(privacy, 'Direct messages'), 'Anyone');
expect('the current choice is not offered again', buttonNamed(privacy, 'privacy:dm:everyone')?.disabled, true);
expect('but the other one is', buttonNamed(privacy, 'privacy:dm:contacts')?.disabled, false);

const narrowed = await press(dev, privacy, 'privacy:dm:contacts');
expect('pressing it updates the card', fieldNamed(narrowed.json.message, 'Direct messages'), 'People you follow');

// The card is not the source of truth — the account is.
const settings = await call('GET', '/users/me', null, dev.auth);
expect('and the account really changed', settings.json.user?.privacy?.whoCanDm, 'contacts');
expect('leaving other settings alone', settings.json.user?.privacy?.whoCanSeeAvatar, 'everyone');

console.log('\n── /report walks someone through it ───────────────');
const r1 = await tellYapper(dev, '/report', yapper.id);
expect('it asks who', embedOf(r1).title, 'Who are you reporting?');

const rSelf = await tellYapper(dev, `@${dev.username}`, yapper.id);
expect('reporting yourself is refused', /That is you/i.test(rSelf?.content ?? ''), true);

const rBot = await tellYapper(dev, '@yapper', yapper.id);
expect('reporting a bot is refused', /That is a bot/i.test(rBot?.content ?? ''), true);

const rMissing = await tellYapper(dev, '@nobody_here_at_all', yapper.id);
expect('an unknown handle is refused', /cannot find/i.test(rMissing?.content ?? ''), true);

const rFound = await tellYapper(dev, `@${other.username}`, yapper.id);
expect('a real person is echoed back to confirm', embedOf(rFound).title, 'Is this who you mean?');
expect('with confirm and cancel', buttons(rFound).length, 2);
expect('and only the reporter may answer', buttonNamed(rFound, 'report:target-yes')?.onlyUserId, dev.id);

const rReason = await press(dev, rFound, 'report:target-yes');
expect('confirming asks what it is about', embedOf(rReason.json.message).title, 'What is it about?');

const rProof = await tellYapper(dev, 'Kept sending abuse after being asked to stop.', yapper.id);
expect('then it asks for proof', embedOf(rProof).title, 'Any proof?');

const rReview = await tellYapper(dev, 'skip', yapper.id);
expect('then it shows the whole thing back', embedOf(rReview).title, 'Send this report?');
expect('naming the target', fieldNamed(rReview, 'About'), `@${other.username}`);
expect('the reason', /abuse/i.test(fieldNamed(rReview, 'Reason') ?? ''), true);
expect('and saying proof was skipped', fieldNamed(rReview, 'Proof'), 'None given');
expect('with submit and cancel', buttons(rReview).length, 2);

const rDone = await press(dev, rReview, 'report:submit');
expect('submitting confirms', embedOf(rDone.json.message).title, 'Report sent');
expect('with a reference', (fieldNamed(rDone.json.message, 'Reference') ?? '').length, 8);
expect('and the buttons retire', buttons(rDone.json.message).length, 0);

const rReplay = await press(dev, rReview, 'report:submit');
expect('the same report cannot be filed twice', rReplay.status >= 400, true);

// A skipped proof must be absent from the record, not the words "None given" —
// display text in a moderation queue reads as something the reporter typed.
const withProof = await tellYapper(dev, '/report', yapper.id);
await tellYapper(dev, `@${other.username}`, yapper.id);
const wpConfirm = await call(
  'GET',
  `/conversations/${withProof.conversationId}/messages?limit=5`,
  null,
  dev.auth,
);
const wpCard = (wpConfirm.json.messages ?? []).find(
  (m) => (m.embeds ?? [])[0]?.title === 'Is this who you mean?',
);
await press(dev, { ...wpCard, conversationId: withProof.conversationId }, 'report:target-yes');
await tellYapper(dev, 'Spamming invite links', yapper.id);
const wpReview = await tellYapper(dev, 'https://example.com/screenshot.png', yapper.id);
expect('a real proof is carried through', fieldNamed(wpReview, 'Proof'), 'https://example.com/screenshot.png');
await press(dev, wpReview, 'report:submit');

console.log('\n── /report can be abandoned ───────────────────────');
const c1 = await tellYapper(dev, '/report', yapper.id);
expect('a fresh one starts', embedOf(c1).title, 'Who are you reporting?');
const c2 = await tellYapper(dev, `@${other.username}`, yapper.id);
const c3 = await press(dev, c2, 'report:cancel');
expect('cancel says nothing was sent', embedOf(c3.json.message).title, 'Cancelled');
const c4 = await tellYapper(dev, 'an ordinary sentence', yapper.id);
expect('and typing is ordinary again', c4, null);

console.log('\n── changing a password ends other sessions ────────');
const victim = await signUp('victim', 'Victim');
// A second sign-in, standing in for the attacker's device.
const attacker = await call('POST', '/auth/login', {
  email: victim.email, password: PASSWORD, client: CLIENT,
});
const stolenAuth = `Bearer ${attacker.json.accessToken}`;
expect('the second session works', (await call('GET', '/users/me', null, stolenAuth)).status, 200);

const changed = await call('POST', '/auth/change-password', {
  currentPassword: PASSWORD, newPassword: 'a-completely-different-one',
}, victim.auth);
expect('the change succeeds', changed.status, 200);

// The epoch moved, so tokens minted before it are dead everywhere.
expect('the other session is dead', (await call('GET', '/users/me', null, stolenAuth)).status, 401);
expect(
  'and its refresh token cannot revive it',
  (await call('POST', '/auth/refresh', { refreshToken: attacker.json.refreshToken })).status >= 400,
  true,
);
expect(
  'while the caller keeps working',
  (await call('GET', '/users/me', null, `Bearer ${changed.json.accessToken}`)).status,
  200,
);
expect(
  'the old password no longer signs in',
  (await call('POST', '/auth/login', { email: victim.email, password: PASSWORD, client: CLIENT })).status,
  401,
);
expect(
  'and the new one does',
  (await call('POST', '/auth/login', {
    email: victim.email, password: 'a-completely-different-one', client: CLIENT,
  })).status,
  200,
);

const wrongCurrent = await call('POST', '/auth/change-password', {
  currentPassword: 'guessing', newPassword: 'another-one-entirely',
}, `Bearer ${changed.json.accessToken}`);
expect('a wrong current password is refused', wrongCurrent.status, 401);

console.log('\n── the bot is only a bot in its own DM ────────────');
const help = await tellYapper(dev, '/help', yapper.id);
expect('it answers /help with a card', embedOf(help).title, 'yapper');
expect('listing every command it declares', (embedOf(help).fields ?? []).length, 10);

console.log('\n───────────────────────────────────────────────────');
console.log(failures === 0 ? '✓ portal sign-in holds' : `✗ ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
