/** Run against a local dev/preview server. All API requests and gateway events are fixtures. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const base = process.env.WEB_QA_URL || 'http://localhost:5173';
assert(['localhost', '127.0.0.1'].includes(new URL(base).hostname), 'Use a local server only');
const output = new URL('../../../.tools/notifications-qa/', import.meta.url);
await mkdir(output, { recursive: true });
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const time = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const me = {
  id: id(1),
  username: 'alex',
  displayName: 'Alex Morgan',
  email: 'alex@example.invalid',
  emailVerified: true,
  bio: '',
  avatarUrl: null,
  isBot: false,
  presence: { status: 'online', customStatus: null },
  notifications: {},
};
const sam = { ...me, id: id(2), username: 'sam', displayName: 'Sam Rivera' };
const conversation = {
  id: id(10),
  type: 'group',
  title: 'Design friends',
  badge: 'verified',
  memberCount: 24,
  latestSeq: 1,
  lastMessageAt: time(1),
  createdAt: time(100),
  permissions: '0',
  self: { mentionCount: 1, unreadCount: 1, lastReadSeq: 0, role: 'member' },
};
const message = {
  id: id(20),
  conversationId: conversation.id,
  seq: 1,
  type: 'text',
  content: '@alex could you take a look?',
  sender: sam,
  senderId: sam.id,
  createdAt: time(3),
  attachments: [],
  reactions: {},
  myReactions: [],
  deletedAt: null,
};
const mention = {
  isBroadcast: false,
  unread: true,
  conversation: { ...conversation, parentTitle: 'Creative community' },
  message,
};
const notice = (n, kind, data, minutes, extra = {}) => ({
  id: id(n),
  kind,
  actor: sam,
  targetType: 'conversation',
  targetId: conversation.id,
  data,
  readAt: null,
  createdAt: time(minutes),
  ...extra,
});
let notices = [
  notice(30, 'role_granted', { title: 'Design friends', role: 'admin' }, 1),
  notice(
    31,
    'group_verified',
    { title: 'Pittsburgh / design community and creative friends', badge: 'verified' },
    2,
  ),
  notice(32, 'group_verified', { title: 'Design partners', badge: 'partner' }, 4),
  notice(
    33,
    'account_suspended',
    {
      title: 'Your account was suspended',
      body: 'Repeated harassment after a warning.',
      until: '2026-09-13T12:00:00Z',
      detail:
        'Suspended until Sun, 13 Sep 2026 12:00:00 GMT.\n\nWhile suspended, you cannot sign in or post. Your messages and groups have not been deleted.\n\nContact support if you believe this is a mistake.',
      supportUrl: 'https://yappy.gg/support/?topic=appeal#appeal=fixture-token',
    },
    5,
    { actor: null, targetType: 'user', targetId: me.id },
  ),
];
const older = notice(
  34,
  'account_restored',
  { title: 'Your account is restored', body: 'You can sign in and post again.' },
  200,
  { targetId: me.id, targetType: 'user' },
);
let mentionsFail = false,
  noticesFail = false,
  conversationMissing = false,
  selective = true,
  socket,
  sequence = 0;
const reads = [],
  errors = [];
let feedRequests = 0;
let feedDelayMs = 0;
let pendingFeedRequests = 0;
const browser = await chromium.launch({
  channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge',
  headless: true,
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  colorScheme: 'dark',
});
await context.addInitScript(
  ({ me }) => {
    localStorage.setItem(
      'yappy.session',
      JSON.stringify({ accessToken: 'fixture', refreshToken: 'fixture', user: me }),
    );
    localStorage.setItem('yappy.tour.done', '1');
  },
  { me },
);
await context.route('**/*', async (route) => {
  const request = route.request(),
    url = new URL(request.url());
  if (!url.pathname.startsWith('/v1/')) {
    if (
      url.origin === new URL(base).origin ||
      ['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname)
    )
      return route.continue();
    return route.abort();
  }
  const path = url.pathname.slice(3),
    method = request.method();
  const headers = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': '*',
  };
  if (method === 'OPTIONS') return route.fulfill({ status: 204, headers });
  let body = {},
    status = 200;
  const feed = path === '/social/notifications' || path === '/users/me/mentions';
  if (feed) {
    pendingFeedRequests++;
    if (feedDelayMs) await delay(feedDelayMs);
  }
  if (path === '/users/me') body = { user: me };
  else if (path === `/users/${sam.id}`)
    body = {
      user: {
        ...sam,
        badges: [],
        relationship: { following: false, followedBy: true, isMutual: false },
      },
    };
  else if (path === '/sync/badge')
    body = { unreadNotifications: [...notices, older].filter((n) => !n.readAt).length };
  else if (path === '/social/notifications') {
    feedRequests++;
    if (noticesFail) status = 503;
    else
      body = {
        notifications: url.searchParams.has('cursor') ? [notices.at(-1), older] : notices,
        nextCursor: url.searchParams.has('cursor') ? null : older.createdAt,
        supportsSelectiveRead: selective,
      };
  } else if (path === '/social/notifications/read') {
    const data = request.postData() ? request.postDataJSON() : {};
    reads.push(data);
    for (const n of [...notices, older])
      if (!data.ids || data.ids.includes(n.id)) n.readAt = time(0);
    body = { ok: true };
  } else if (path === '/users/me/mentions') {
    if (mentionsFail) status = 503;
    else body = { mentions: [mention] };
  } else if (path === '/conversations' && method === 'POST')
    body = { conversation: { ...conversation, id: id(50), type: 'dm', otherUser: sam } };
  else if (path === '/conversations')
    body = {
      conversations:
        url.searchParams.has('hidden') || url.searchParams.has('archived') ? [] : [conversation],
    };
  else if (path === `/conversations/${conversation.id}`) {
    body = { conversation };
    if (conversationMissing) status = 404;
  } else if (path.endsWith('/messages')) body = { messages: [message], hasMore: false };
  else if (path.endsWith('/members'))
    body = {
      members: [
        { user: me, role: 'member' },
        { user: sam, role: 'member' },
      ],
    };
  else if (path.endsWith('/pins')) body = { pins: [] };
  else if (path.endsWith('/media')) body = { messages: [], hasMore: false };
  else if (path.endsWith('/receipts')) body = { receipts: [] };
  else if (path.endsWith('/emoji') || path.endsWith('/emojis')) body = { emoji: [], emojis: [] };
  else if (path.startsWith('/social/')) body = { users: [], nextCursor: null };
  else if (path === '/devices' || path.startsWith('/keys/')) body = { devices: [] };
  else body = { items: [], commands: [], channels: [], users: [] };
  await route.fulfill({
    status,
    headers,
    contentType: 'application/json',
    body: JSON.stringify(status === 200 ? body : { error: { message: 'Fixture outage' } }),
  });
  if (feed) pendingFeedRequests--;
});
await context.routeWebSocket(/(3001|ws\.yappy\.gg)/, (ws) => {
  socket = ws;
});
const page = await context.newPage();
page.on('pageerror', (e) => errors.push(e.message));
const wait = async (predicate, label) => {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error(label);
};
const bell = () => page.getByRole('button', { name: 'Notifications', exact: true });
const dialog = () => page.getByRole('dialog', { name: 'Notifications', exact: true });
const filter = (name) => dialog().getByRole('button', { name, exact: true });
const rows = () => dialog().locator('.inbox-row');
const shot = (name) => page.screenshot({ path: fileURLToPath(new URL(`${name}.png`, output)) });
const emit = async (entry, event = 'notification.create') => {
  const previous = feedRequests;
  notices.unshift(entry);
  await wait(() => socket, 'Gateway did not connect');
  socket.send(
    JSON.stringify({
      op: 5,
      t: event,
      s: ++sequence,
      d: {
        kind: entry.kind,
        targetType: entry.targetType,
        targetId: entry.targetId,
        data: entry.data,
      },
    }),
  );
  if (await dialog().count())
    await wait(() => feedRequests > previous, 'Live event did not reload the feed');
};
try {
  await page.goto(base);
  await wait(
    async () => (await bell().textContent()) === '6',
    'Bell did not combine account and mention counts',
  );
  await bell().click();
  await wait(async () => (await rows().count()) === 5, 'Unified feed did not load');
  await wait(() => reads.length === 1, 'Loaded updates were not acknowledged');
  assert.deepEqual(new Set(reads[0].ids), new Set(notices.map((n) => n.id)));
  assert.equal(older.readAt, null, 'An unloaded page was marked read');
  const titles = await dialog().locator('.inbox-where').allTextContents();
  assert.deepEqual(titles, [
    'You’re an admin of Design friends',
    'Pittsburgh / design community and creative friends is verified',
    'Creative community / Design friends',
    'Design partners is a yappy partner',
    'Your account was suspended',
  ]);
  assert.equal(await dialog().locator('.notice-seal').count(), 2);
  await shot('desktop-dark');
  await filter('Close notifications').click();
  feedDelayMs = 1500;
  const reopenStart = Date.now();
  await bell().click();
  await rows().filter({ hasText: 'Pittsburgh / design community' }).waitFor({ timeout: 700 });
  const reopenMs = Date.now() - reopenStart;
  assert(reopenMs < 700, `Cached inbox waited for the network (${reopenMs}ms)`);
  assert.equal(await rows().count(), 5, 'Cached mentions and updates should both appear immediately');
  assert.equal(await dialog().getByText('Loading…', { exact: true }).count(), 0);
  await wait(() => pendingFeedRequests === 0, 'Background refresh did not settle');
  feedDelayMs = 0;
  console.log(`PASS cached inbox reopened in ${reopenMs}ms with 1500ms API delays`);
  await filter('Updates').click();
  assert.equal(await rows().count(), 4);
  await filter('Mentions').click();
  assert.equal(await rows().count(), 1);
  const readCount = reads.length;
  await emit(
    notice(
      35,
      'new_sign_in',
      { title: 'New sign-in', body: 'A new browser signed in to your account.' },
      -1,
      { targetType: 'user', targetId: me.id },
    ),
  );
  await wait(
    async () => (await bell().textContent()) === '3',
    'Live unread badge was not refreshed',
  );
  assert.equal(reads.length, readCount, 'Hidden Updates were acknowledged from the Mentions tab');
  await filter('All').click();
  await wait(
    () => reads.some((r) => r.ids?.includes(id(35))),
    'Visible live update was not acknowledged',
  );
  await filter('Load older updates').click();
  await wait(
    async () => (await rows().count()) === 7,
    'Pagination did not merge without duplicates',
  );
  await wait(() => older.readAt, 'Older loaded page was not acknowledged');
  await filter('Mark updates read').click();
  await wait(
    async () => (await dialog().locator('.unread .notice-avatar').count()) === 0,
    'Mark all did not clear update highlighting',
  );
  assert(
    reads.some((r) => !r.ids),
    'Explicit mark-all did not use the compatible endpoint',
  );
  await rows().filter({ hasText: 'Your account was suspended' }).click();
  await dialog().getByRole('heading', { name: 'Your account was suspended' }).waitFor();
  const appeal = dialog().getByRole('link', { name: 'Appeal suspension' });
  const appealUrl = new URL(await appeal.getAttribute('href'));
  assert.equal(appealUrl.pathname, '/support/');
  assert.equal(appealUrl.searchParams.get('topic'), 'appeal');
  assert.equal(appealUrl.hash, '#appeal=fixture-token');
  assert.equal(
    await dialog().locator('.notice-deadline time').getAttribute('datetime'),
    '2026-09-13T12:00:00.000Z',
  );
  assert(!(await dialog().locator('.notice-detail-text').textContent()).includes('GMT'));
  await shot('suspension-desktop');
  const beforeDetailEvent = reads.length;
  await emit(
    notice(
      36,
      'badge_granted',
      { title: 'Your badge is live', body: 'Your profile is now verified.' },
      -2,
      { targetType: 'user', targetId: me.id },
    ),
  );
  await wait(
    async () => (await bell().textContent()) === '2',
    'Unread update during details was lost',
  );
  assert.equal(
    reads.length,
    beforeDetailEvent,
    'Unseen update was acknowledged behind the details view',
  );
  await page.keyboard.press('Escape');
  await wait(
    () => reads.some((r) => r.ids?.includes(id(36))),
    'Returning to the list did not acknowledge the new update',
  );
  await filter('Mentions').click();
  await rows().first().click();
  await wait(
    async () => (await dialog().count()) === 0 && page.url().endsWith('/c/' + conversation.id),
    'Mention did not open its conversation',
  );
  await page.locator('.message-entry').first().waitFor();
  await emit(notice(37, 'group_verified', { title: 'New group', badge: 'verified' }, -3));
  await wait(
    async () => (await bell().textContent()) === '1',
    'Closed inbox did not receive a live unread update',
  );
  await bell().click();
  await rows().filter({ hasText: 'New group is verified' }).waitFor();
  await filter('Close notifications').focus();
  await page.keyboard.press('Shift+Tab');
  assert(
    await page.evaluate(() =>
      document.querySelector('.notification-inbox').contains(document.activeElement),
    ),
    'Keyboard focus escaped the dialog',
  );
  for (const width of [320, 390, 760, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    const box = await dialog().boundingBox();
    assert(box.x >= 0 && box.x + box.width <= width, `Dialog overflow at ${width}`);
    assert(
      await dialog().evaluate((el) => el.scrollWidth <= el.clientWidth),
      `Content overflow at ${width}`,
    );
    if (width === 390) {
      await shot('phone-dark');
      await rows().filter({ hasText: 'Your account was suspended' }).click();
      await shot('suspension-phone');
      await page.setViewportSize({ width: 390, height: 440 });
      await appeal.scrollIntoViewIfNeeded();
      assert(await appeal.isVisible());
      await filter('Back to notifications').click();
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await shot('desktop-light');
  await filter('Close notifications').click();
  mentionsFail = true;
  await bell().click();
  await page.getByText('Mentions couldn’t load.', { exact: false }).waitFor();
  assert(
    (await rows().filter({ hasText: 'is verified' }).count()) >= 1,
    'Mention outage hid account updates',
  );
  mentionsFail = false;
  await filter('Retry').click();
  await rows().filter({ hasText: 'could you take a look' }).waitFor();
  await filter('Close notifications').click();
  noticesFail = true;
  await bell().click();
  await page.getByText('Updates couldn’t load.', { exact: false }).waitFor();
  assert.equal(await rows().filter({ hasText: 'could you take a look' }).count(), 1, 'Update outage hid mentions');
  assert((await rows().count()) > 1, 'Update outage discarded previously loaded notifications');
  noticesFail = false;
  await filter('Retry').click();
  await rows().filter({ hasText: 'is a yappy partner' }).waitFor();
  conversationMissing = true;
  const currentUrl = page.url();
  await rows().filter({ hasText: 'is a yappy partner' }).click();
  await page.getByText('This conversation is no longer available to you.').waitFor();
  assert.equal(
    page.url(),
    currentUrl,
    'Unavailable notification target changed the current conversation',
  );
  conversationMissing = false;
  await filter('Close notifications').click();
  selective = false;
  notices[0].readAt = null;
  const oldApiReads = reads.length;
  await bell().click();
  await rows().filter({ hasText: 'is a yappy partner' }).waitFor();
  assert.equal(reads.length, oldApiReads, 'An older API silently marked all updates read');
  await filter('Mark updates read').click();
  await wait(() => reads.length > oldApiReads, 'Legacy mark-all failed');
  assert.deepEqual(reads.at(-1), {});
  await filter('Close notifications').click();
  selective = true;
  await emit(
    notice(38, 'follow', {}, -4, { targetType: 'user', targetId: sam.id }),
    'relationship.update',
  );
  await wait(
    async () => (await bell().textContent()) === '1',
    'Legacy follow event did not update unread count',
  );
  await bell().click();
  await rows().filter({ hasText: 'Sam Rivera followed you' }).click();
  const profile = page.getByRole('dialog', { name: 'Profile', exact: true });
  await profile.getByText('@sam', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  assert(await dialog().isVisible(), 'Closing a profile also closed notifications');
  await rows().filter({ hasText: 'Sam Rivera followed you' }).click();
  await profile.getByRole('button', { name: 'Message', exact: true }).click();
  await wait(
    async () => (await dialog().count()) === 0 && page.url().endsWith('/c/' + id(50)),
    'Opening a DM from a notification profile left the inbox covering it',
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS notifications: merged order, badges, filters, selective read, pagination, live events, details, appeals, mention navigation, keyboard focus, responsive sizes, light/dark, partial outages, retry, legacy API.',
  );
} catch (error) {
  await shot('failure');
  throw error;
} finally {
  await browser.close();
}
