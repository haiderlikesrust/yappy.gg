/** Local-only browser fixtures: no messages, reminders, or events reach real users. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_MODULE_PATH || "playwright",
);
const base = process.env.WEB_QA_URL || "http://localhost:4183";
assert(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
const output = new URL("../../../.tools/community-qa/", import.meta.url);
await mkdir(output, { recursive: true });
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = new Date().toISOString(),
  later = new Date(Date.now() + 86400000).toISOString();
const me = {
  id: id(1),
  username: "alex",
  displayName: "Alex",
  email: "alex@example.invalid",
  emailVerified: true,
  isBot: false,
  presence: { status: "online" },
  notifications: {},
};
const room = {
  id: id(2),
  type: "group",
  title: "Design friends",
  memberCount: 8,
  permissions: "4611686292247314431",
  latestSeq: 1,
  createdAt: now,
  lastMessageAt: now,
  self: { role: "owner", lastReadSeq: 0, unreadCount: 1, mentionCount: 0 },
};
const message = {
  id: id(3),
  conversationId: room.id,
  seq: 1,
  type: "text",
  content: "Let’s make something together.",
  senderId: me.id,
  sender: me,
  createdAt: now,
  attachments: [],
  reactions: {},
  myReactions: [],
  deletedAt: null,
};
let collection = { id: id(4), name: "Ideas", count: 1 };
let saved = [
  {
    messageId: message.id,
    conversationId: room.id,
    conversationTitle: room.title,
    seq: 1,
    content: message.content,
    sender: "Alex",
    savedAt: now,
    collectionId: collection.id,
    note: "Keep this thought",
  },
];
let events = [
  {
    id: id(5),
    conversationId: room.id,
    conversationTitle: room.title,
    title: "Design night",
    description: "Bring an idea and a cup of tea.",
    location: "Main chat",
    startsAt: later,
    endsAt: null,
    cancelledAt: null,
    response: null,
    remind: false,
    going: 3,
    maybe: 1,
    canManage: true,
  },
];
let reminders = [],
  scheduled = [],
  sends = [],
  notesFail = false,
  sendFail = true;
const writes = [],
  errors = [];
const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  colorScheme: "dark",
});
await context.addInitScript(
  ({ me }) => {
    localStorage.setItem(
      "yappy.session",
      JSON.stringify({
        accessToken: "fixture",
        refreshToken: "fixture",
        user: me,
      }),
    );
    localStorage.setItem("yappy.tour.done", "1");
  },
  { me },
);
await context.routeWebSocket(
  /(3001|ws\.yappy\.gg|gateway\.yappy\.gg)/,
  () => {},
);
await context.route("**/*", async (route) => {
  const req = route.request(),
    url = new URL(req.url()),
    method = req.method(),
    path = url.pathname.replace(/^\/v1/, "");
  if (!url.pathname.startsWith("/v1/"))
    return url.origin === new URL(base).origin
      ? route.continue()
      : route.abort();
  const headers = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "*",
  };
  if (method === "OPTIONS") return route.fulfill({ status: 204, headers });
  const input = req.postData() ? req.postDataJSON() : {};
  if (method !== "GET") writes.push({ path, method, input });
  let status = 200,
    body = { items: [], commands: [], channels: [], users: [], receipts: [] };
  if (path === "/users/me") body = { user: me };
  else if (path === "/sync/badge") body = { unreadNotifications: 0 };
  else if (path === "/social/notifications")
    body = { notifications: [], supportsSelectiveRead: true };
  else if (path === "/users/me/mentions") body = { mentions: [] };
  else if (path === "/users/me/saved")
    body = {
      items: saved.map((s) => ({ savedAt: now, conversation: room, message })),
    };
  else if (path === "/community/catch-up")
    body = {
      items: [
        {
          id: message.id,
          kind: "reply",
          conversationId: room.id,
          conversationTitle: room.title,
          messageId: message.id,
          seq: 1,
          title: "Alex replied",
          body: message.content,
          createdAt: now,
        },
      ],
      rooms: [{ conversationId: room.id, title: room.title, unreadCount: 1 }],
    };
  else if (path === "/community/events") body = { events };
  else if (path.endsWith("/rsvp")) {
    events[0] = { ...events[0], ...input };
    body = { ok: true };
  } else if (path === "/community/reminders") {
    if (method === "POST")
      reminders.push({
        ...input,
        conversationId: room.id,
        seq: 1,
        title: message.content,
      });
    body = { reminders };
  } else if (path.startsWith("/community/reminders/")) {
    reminders = [];
    body = { ok: true };
  } else if (path === "/community/scheduled") {
    if (method === "POST")
      scheduled.push({
        ...input,
        conversationTitle: room.title,
        failedAt: null,
        failure: null,
      });
    body = { messages: scheduled };
  } else if (path === "/community/collections")
    body = { collections: [collection] };
  else if (path.startsWith("/community/collections/")) {
    collection = { ...collection, ...input };
    body = { collection };
  } else if (path === "/community/saved")
    body = {
      items: saved.filter(
        (s) =>
          !url.searchParams.get("q") ||
          s.note.includes(url.searchParams.get("q")),
      ),
    };
  else if (path.startsWith("/community/saved/")) {
    if (method === "PUT") {
      if (notesFail) status = 503;
      else saved[0] = { ...saved[0], ...input };
    }
    body = saved[0];
  } else if (path.endsWith("/welcome"))
    body = {
      profile: {
        welcome: "Find your people. Make yourself at home.",
        rules: "Be kind.",
        tags: ["design"],
        language: "en",
        startChannelId: null,
      },
      seen: false,
      canManage: true,
      channels: [],
    };
  else if (path === "/conversations")
    body = {
      conversations:
        url.searchParams.has("hidden") || url.searchParams.has("archived")
          ? []
          : [room],
    };
  else if (path === `/conversations/${room.id}`) body = { conversation: room };
  else if (path.endsWith("/messages")) {
    if (method === "POST") {
      sends.push(input);
      if (sendFail) {
        sendFail = false;
        status = 503;
      } else
        body = {
          message: { ...message, id: id(9), seq: 2, content: input.content },
        };
    } else body = { messages: [message], hasMore: false };
  } else if (path.endsWith("/members"))
    body = { members: [{ user: me, role: "owner" }] };
  else if (path.endsWith("/pins")) body = { pins: [] };
  else if (path.endsWith("/media")) body = { messages: [], hasMore: false };
  else if (path.endsWith("/emojis") || path.endsWith("/emoji"))
    body = { emoji: [], emojis: [] };
  else if (path.startsWith("/social/")) body = { users: [] };
  else if (path === "/devices" || path.startsWith("/keys/"))
    body = { devices: [] };
  await route.fulfill({
    status,
    headers,
    contentType: "application/json",
    body: JSON.stringify(
      status >= 400
        ? {
            error: {
              code: "unavailable",
              message: "Fixture outage. Try again.",
            },
          }
        : body,
    ),
  });
});
const page = await context.newPage();
page.on("pageerror", (e) => errors.push(e.message));
const button = (name) => page.getByRole("button", { name, exact: true });
try {
  await page.goto(base + "/catch-up");
  await page.getByRole("heading", { name: "Waiting for you" }).waitFor();
  assert(await page.getByText("Alex replied").isVisible());
  await button("Events").click();
  await page.getByRole("heading", { name: "Design night" }).waitFor();
  await button("Going").click();
  await page.waitForFunction(
    () =>
      document.querySelector('button[aria-pressed="true"]') &&
      [...document.querySelectorAll("button")].some(
        (b) =>
          b.textContent === "Going" &&
          b.getAttribute("aria-pressed") === "true",
      ),
  );
  await page.getByLabel("Remind me 15 minutes before").click();
  await page.waitForFunction(
    () => document.querySelector('input[type="checkbox"]')?.checked,
  );
  assert(
    writes.some(
      (w) =>
        w.path.endsWith("/rsvp") &&
        w.input.response === "going" &&
        w.input.remind,
    ),
  );
  await page.screenshot({
    path: new URL("events-desktop.png", output).pathname.replace(
      /^\/([A-Z]:)/,
      "$1",
    ),
  });
  await button("Saved").click();
  await button("Collection & note").click();
  const editor = page.getByRole("dialog", { name: "Save to a collection" });
  await editor.getByLabel("Personal note").fill("A note worth keeping");
  notesFail = true;
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await editor.getByRole("alert").waitFor();
  assert.equal(
    await editor.getByLabel("Personal note").inputValue(),
    "A note worth keeping",
  );
  notesFail = false;
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await editor.waitFor({ state: "detached" });
  await page.getByText("Note: A note worth keeping", { exact: true }).waitFor();
  await page.getByLabel("Search saved messages and notes").fill("no-match");
  await page.getByText("No matching saved messages", { exact: true }).waitFor();
  await page.getByLabel("Search saved messages and notes").fill("");
  await button("View message").click();
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.waitFor();
  await button("Read welcome & rules").click();
  const welcome = page.getByRole("dialog", {
    name: "Events & welcome",
    exact: true,
  });
  await welcome
    .getByRole("button", { name: "Create event", exact: true })
    .click();
  const eventEditor = page.getByRole("dialog", {
    name: "Create event",
    exact: true,
  });
  await eventEditor.getByLabel("Event name").fill("A future plan");
  await eventEditor.getByRole("button", { name: "Close", exact: true }).focus();
  await page.keyboard.press("Shift+Tab");
  assert(
    await eventEditor.evaluate((el) => el.contains(document.activeElement)),
    "Nested event dialog lost keyboard focus",
  );
  await page.keyboard.press("Escape");
  await eventEditor.waitFor({ state: "detached" });
  assert(await welcome.isVisible(), "Escape closed the parent welcome page");
  await page.keyboard.press("Escape");
  await welcome.waitFor({ state: "detached" });
  await composer.fill("Tomorrow’s thought");
  await button("Schedule message").click();
  const schedule = page.getByRole("dialog", { name: "Schedule message" });
  await schedule
    .getByRole("button", { name: "Schedule message", exact: true })
    .click();
  await schedule.waitFor({ state: "detached" });
  assert.equal(await composer.inputValue(), "");
  assert.equal(scheduled[0].content, "Tomorrow’s thought");
  await composer.fill("Please keep my message");
  await button("Send").click();
  await button("Try again").waitFor();
  await button("Try again").click();
  await page.waitForFunction(
    () => !document.body.textContent.includes("not sent"),
  );
  assert.equal(sends.length, 2);
  assert.equal(
    sends[0].nonce,
    sends[1].nonce,
    "Retry must keep the same nonce",
  );
  await page.goto(base + "/catch-up");
  await button("Scheduled").click();
  await page.getByText("Tomorrow’s thought", { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: new URL("scheduled-mobile.png", output).pathname.replace(
      /^\/([A-Z]:)/,
      "$1",
    ),
  });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    "Mobile page overflows horizontally",
  );
  await page.emulateMedia({ colorScheme: "light" });
  await button("Events").click();
  await page.getByRole("heading", { name: "Design night" }).waitFor();
  await page.screenshot({
    path: new URL("events-mobile-light.png", output).pathname.replace(
      /^\/([A-Z]:)/,
      "$1",
    ),
  });
  assert.deepEqual(errors, []);
  console.log(
    "PASS community browser flows: catch-up, RSVP, reminder preference, collections, search, retained notes after errors, scheduling, stable-nonce send retry, mobile overflow.",
  );
} catch (error) {
  await page.screenshot({
    path: new URL("failure.png", output).pathname.replace(/^\/([A-Z]:)/, "$1"),
  });
  throw error;
} finally {
  await browser.close();
}
