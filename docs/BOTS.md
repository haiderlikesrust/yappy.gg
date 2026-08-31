# Building bots on yappy

A bot on yappy is an ordinary account with `is_bot` set, plus an application
record that holds its credential and names its owner. That one design decision
shapes everything below: a bot joins conversations, appears in the member list,
holds a role, is subject to the same permission bitfield as a person, and can be
kicked or blocked. There is no privileged side door. If a person cannot do a
thing in a conversation, neither can a bot, and if a bot can, it is because the
group granted it the same permission it would grant a person.

This guide covers registering a bot, authenticating, sending rich messages,
attaching buttons, drawing a chart, keeping a card alive, declaring slash
commands, receiving events over a webhook, and the one rule that matters more
than any other: authorisation is always checked against the person who invoked
an action, never against the bot.

The examples are HTTP, because HTTP is the contract and every language can
speak it. In TypeScript, the same thing with types on it:

```bash
npm i @yappydotgg/bot-sdk
```

It has no dependencies — it uses the `fetch` and `WebSocket` Node already has
— and every section below names the SDK call that does the same thing.

## Contents

1. [Register a bot](#1-register-a-bot)
2. [Authenticate](#2-authenticate)
3. [Send messages](#3-send-messages)
4. [Embeds](#4-embeds)
5. [Buttons and interactions](#5-buttons-and-interactions)
6. [Live cards](#6-live-cards)
7. [Slash commands](#7-slash-commands)
8. [The permission model, and the one rule](#8-the-permission-model-and-the-one-rule)
9. [Webhooks](#9-webhooks)
10. [Rate limits and etiquette](#10-rate-limits-and-etiquette)
11. [Reference](#11-reference)

---

## 1. Register a bot

Two ways, same result.

**From the developer portal** (recommended). Open `https://yappy.gg/portal`,
sign in by taking the shown code to `@yapper` in the app, and use the Your Bots
tab. Give the bot a display name and an `@handle`, press Create, and copy the
token from the box. The token is shown exactly once.

**From the API**, with your own account access token:

```
POST /v1/apps
Authorization: Bearer <your account token>
Content-Type: application/json

{ "name": "Weather Bot", "username": "weatherbot", "isPublic": false }
```

```json
{
  "application": {
    "id": "app_...",
    "name": "Weather Bot",
    "bot": { "id": "usr_...", "username": "weatherbot", "isBot": true }
  },
  "token": "yb_9c1f...   (shown once, store it now)"
}
```

The bot's `@handle` shares the same namespace as human usernames. That is
deliberate: one directory, and no registering a lookalike handle to impersonate
an existing account.

Set `isPublic: true` to have the bot listed in the bot directory and addable by
anyone. Leave it false while you develop.

If a token leaks, rotate it:

```
POST /v1/apps/:id/token     → { "token": "yb_new...", "tokenPrefix": "yb_new" }
```

Rotation is immediate and has no grace window, because the reason you rotate is
usually that the old token is already somewhere it should not be.

## 2. Authenticate

Bots use a distinct scheme. Send the token as `Bot`, not `Bearer`:

```
Authorization: Bot yb_9c1f...
```

The first call most SDKs make on boot confirms identity:

```
GET /v1/apps/me
Authorization: Bot yb_9c1f...
```

```json
{
  "application": { "id": "app_...", "name": "Weather Bot", "isPublic": false },
  "user": { "id": "usr_...", "username": "weatherbot", "isBot": true }
}
```

Everything else a bot does is an ordinary API call authenticated with that
header. A bot posting a message calls the same `POST
/conversations/:id/messages` a person's client calls; it is simply subject to
its own membership and permissions in that conversation.

The token is stored only as a SHA-256 hash. Unlike a human password, it is not
run through Argon2: a 256-bit random token has nothing to gain from a slow hash,
and a bot request cannot afford 100ms of hashing on every call.

## 3. Send messages

To post anywhere, the bot has to be a member of the conversation and hold
`SEND_MESSAGES` there. Add the bot the way you add any member, or have a public
bot join a public group.

```
POST /v1/conversations/:id/messages
Authorization: Bot yb_9c1f...
Content-Type: application/json

{ "nonce": "w_20260809_0001", "type": "text", "content": "Sunny, 24C." }
```

`nonce` is required and is your idempotency key. If the request is retried after
a dropped connection, the second call returns the original message with status
200 instead of posting a duplicate; a genuinely new message returns 201. Use a
value you can regenerate deterministically for a given logical send, not a fresh
random string per attempt.

## 4. Embeds

Plain people get link previews. Bots get to hand-build rich cards. This is a bot
affordance on purpose, because a component anyone could author is the most
effective phishing surface a chat product has, so the server refuses embeds and
buttons from non-bot senders.

```json
{
  "nonce": "w_20260809_0002",
  "type": "text",
  "content": null,
  "embeds": [
    {
      "title": "Weather for London",
      "description": "Sunny with a light breeze.",
      "color": "#8b7cff",
      "fields": [
        { "name": "Temperature", "value": "24C", "inline": true },
        { "name": "Humidity", "value": "40%", "inline": true }
      ],
      "footer": { "text": "Updated just now" }
    }
  ]
}
```

An embed can carry a `title` (optionally a clickable `url`), `description`,
`color` (the accent bar, `#RRGGBB`), an `author` with an icon, up to 25
`fields` (two-up when `inline: true`), an `image`, a `thumbnail`, a `chart`,
and a `footer`. The total text across all fields is capped at 6000 characters.

A `chart` is a picture of numbers you also write as fields. Clients that have
never heard of it still render the title and fields; ones that have draw the
picture. Kinds are `line`, `area`, `bar`, `pie`, `donut`, and `scatter`. Two
to twenty-four points (eight for pie and donut), labels at most 16 characters.
The server refuses a chart that is the only thing on the card — put the same
numbers in fields so the chart never carries information alone.

```ts
new EmbedBuilder()
  .title('Market cap')
  .field('Now', '$12.4K', true)
  .field('ATH', '$40.1K', true)
  .chart('bar', [
    { label: 'Now', value: 12_400 },
    { label: 'ATH', value: 40_100 },
  ])
  .build();
```

Only the title is ever a link. A card whose every pixel is clickable is how
people get phished, so clients make just the title open the URL.

## 5. Buttons and interactions

Attach up to five rows of up to five buttons each. A press is delivered to your
bot, and your bot answers by either rewriting the message or posting a new one.

```json
{
  "nonce": "poll_20260809_0001",
  "type": "text",
  "content": null,
  "embeds": [{ "title": "Deploy to production?", "color": "#f5a524", "fields": [] }],
  "components": [
    {
      "type": "row",
      "components": [
        { "type": "button", "customId": "deploy:yes", "label": "Deploy", "style": "success" },
        { "type": "button", "customId": "deploy:no",  "label": "Cancel", "style": "danger" }
      ]
    }
  ]
}
```

A button carries:

- `customId` (up to 100 chars). Opaque to yappy, echoed back to you on press.
  Encode your own routing in it. It is **not** a secret and confers nothing;
  authorisation is separate (see below).
- `label`, and a `style` of `primary`, `secondary`, `success`, or `danger`.
- `disabled`, to grey a button out. A spent prompt should disable its buttons.
- `onlyUserId`, to restrict the press to one person. Set it on anything
  consequential posted where others can see it.
- `requiredPermissions`, a decimal permission bitfield the presser must hold.
  The SDK accepts a name and writes the decimal for you:
  `button('ban', 'Ban', 'danger', { requiredPermissions: 'BAN_MEMBERS' })`.
- `staffOnly`, for yappy staff. Not for third-party bots.

**How a press reaches you.** If your application has a webhook set, a press
arrives as an `interaction.pressed` event (see [Webhooks](#9-webhooks)). To act
on it, call the interactions endpoint or, more usually, edit the message with
your bot token. A bot can rewrite only its own messages:

```
PATCH /v1/conversations/:id/messages/:messageId
Authorization: Bot yb_9c1f...

{ "content": "Deploying...", "components": [] }
```

Sending empty `components` retires the buttons, which is the right move the
moment a prompt has been answered.

## 6. Live cards

A card that rewrites itself. The first `render()` is the post; every tick
after that is an edit of the same message. Edits never push a phone.

```ts
await bot.live(conversationId, {
  every: '30s',
  until: '10m',
  silent: false,          // first post notifies; omit to stay quiet
  replyToId: message.id,
  nonce: `scan_${message.id}_${mint.slice(0, 8)}`,
  render: async () => {
    const coin = await fetchCoin(mint);
    return coin ? scanCard(coin) : null;
  },
});
```

`every` floors at ten seconds. `until` caps at 24 hours. Returning `null`
from `render` skips a tick; throwing skips a tick and calls `onError`. A 404
on the edit (the message was deleted) stops the live.

This is a loop in *your* process. A serverless webhook with nothing kept
alive cannot use it — that is what a Refresh button is for. Do not also set
a webhook if the bot is holding a socket: both transports deliver everything,
and a live card does not change that.

A process holds at most 25 lives. The 26th stops the oldest. Call
`card.stop()` to end one early, or `bot.stopLives()` to end them all.

## 7. Slash commands

Declare the commands your bot answers so the composer can offer them as
autocomplete. Declared, not asked at keystroke time: the composer needs an
answer on the first character after `/`, and a bot that is asleep must not make
typing feel broken.

```
PUT /v1/apps/:id/commands
Authorization: Bearer <owner token>   (or Bot, or a portal session)

{
  "commands": [
    { "name": "weather", "description": "Current weather for a city" },
    { "name": "ban", "description": "Ban a member", "requiredPermissions": "4294967296" }
  ]
}
```

Each command has a lowercase `name`, a `description`, an optional `usage`
string, an optional `requiredPermissions` bitfield, and an optional `staffOnly`
flag. `4294967296` above is `perms.bits('KICK_MEMBERS')` — `1 << 32`.

The commands endpoint (`GET /conversations/:id/commands`) filters what each
member is offered by their own permissions. A member who cannot kick is never
shown `/ban`. This is exactly Discord's `default_member_permissions`, applied at
the source.

## 8. The permission model, and the one rule

The rule, stated plainly:

> **Authorisation is always checked against the person who invoked the action,
> never against the bot.**

A moderation bot may hold every permission in a group. That does not let an
ordinary member borrow those powers by pressing one of the bot's buttons. When a
button carries `requiredPermissions`, the server checks the **presser's**
effective permissions in that conversation, not the bot's, and refuses the press
with 403 if they fall short. The same is true of `staffOnly` buttons, which
check `is_staff` on the presser.

This is enforced in three independent layers, so no single change can open the
gap:

1. **Visibility.** `GET /conversations/:id/commands` returns only the commands
   the requesting member could invoke. `/ban` does not appear in a normal
   member's autocomplete.
2. **The press.** When a `requiredPermissions` or `staffOnly` button is pressed,
   the server validates the presser before your bot is ever told about it.
3. **Your own check.** When you receive an interaction over a webhook, the
   payload includes the invoker's `permissions` and `isStaff` so you can make
   your own decision without a second call. You still should: layers 1 and 2 are
   the platform's promise, and this is yours.

To look up a member's authority yourself, for example before acting on a typed
`/ban @someone`:

```
GET /v1/conversations/:id/members/:userId/permissions
```

```json
{ "userId": "usr_...", "permissions": "4398046511111", "isStaff": false }
```

`permissions` is a decimal string, because JavaScript numbers lose precision
past 2^53 and the bitfield runs to bit 62. The SDK does the parse for you:

```ts
import { perms } from '@yappydotgg/bot-sdk';

if (!perms.has(invoker.permissions, 'KICK_MEMBERS')) return { kind: 'ack' };
```

`perms.bits('KICK_MEMBERS', 'BAN_MEMBERS')` builds the decimal string to put
on a command or a button. The bit values are in the [reference](#11-reference).

### What your bot itself may do

Everything above is about the *presser*. Your bot's own authority is separate,
and it is granted per space by a human when they install you:

```
PUT /v1/conversations/:spaceId/apps/:applicationId   { "permissions": "<decimal>" }
```

Ask for the least that does the job. `MANAGE_CONVERSATION` opens and edits
channels; add `MANAGE_ROLES` if you also need to make a channel private, admit
people to it, or hand out roles.

Your bot sits at ladder rank `member` and is never promoted — that is the point.
It may act on ordinary members without outranking them, so a support bot can
give somebody a role, but it can never touch a moderator, never exceed the
permissions it was granted, and never be an administrator. That last one is
refused to everybody, the space owner included.

Once installed:

```ts
// Any channel.
const { channel } = await bot.createChannel(spaceId, { title: 'releases' });

// A private one, with the person who asked let in. Staff see it too — that is
// what makes it answerable.
await bot.createChannel(spaceId, {
  title: `ticket-${user.username}`,
  isPrivate: true,
  members: [user.id],
});
```

**Do not build a role per ticket.** `LIMITS.rolesPerConversation` is 50: the
design reads beautifully and then ticket 51 fails and the space is stuck with
fifty dead roles. `members` is a per-member grant with no ceiling that leaves
nothing behind when the ticket closes. Roles are for standing groups —
Moderators, Premium — not for access that expires.

## 9. Webhooks

A webhook is how your bot hears about the world when it is not the one making
the request. Set it from the portal or the API:

```
PUT /v1/apps/:id/webhook
{ "url": "https://your-server.example/yappy" }
```

```json
{ "webhookUrl": "https://your-server.example/yappy", "secret": "a1b2c3...   (once)" }
```

The URL must be `https` outside of localhost. The signing secret is returned
exactly once. Store it beside the token.

**What you receive.** yappy POSTs JSON to your URL for two event types:

- `message.created`, for every message in a conversation your bot is in (except
  its own, so you cannot loop).
- `interaction.pressed`, when one of your buttons is pressed.

```json
{
  "type": "interaction.pressed",
  "data": {
    "conversationId": "cnv_...",
    "messageId": "msg_...",
    "customId": "deploy:yes",
    "invoker": { "userId": "usr_...", "permissions": "4398046511111", "isStaff": false }
  },
  "sentAt": "2026-08-09T12:00:00.000Z"
}
```

**Verify the signature before trusting anything.** Every delivery carries an
`X-Yappy-Signature` header: the HMAC-SHA256 of the exact raw request body, hex
encoded, keyed with your signing secret. A webhook URL leaks eventually, through
logs or a config repo or a shared screen, and an endpoint that does not verify
then accepts fabricated "the admin approved it" events from anyone who found the
URL.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(rawBody, signatureHeader, secret) {
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader ?? '');
  return a.length === b.length && timingSafeEqual(a, b);
}
```

Compute the HMAC over the body bytes as received, before any JSON parsing, and
compare in constant time.

**Delivery guarantees.** Deliveries are queued and retried with exponential
backoff, five attempts. A webhook that is briefly down gets the event late, not
never; one that is down for good stops costing anything once the retries are
spent. Respond `2xx` quickly. Do your slow work after acknowledging, not before,
or the delivery times out at five seconds and retries needlessly. The webhook
config is re-read on each attempt, so rotating a leaked URL takes effect on the
next retry.

## 10. Rate limits and etiquette

Bots share the same rate limits as everyone else, keyed on the bot account.
A 429 comes with `Retry-After` and `error.retryAfter`; respect it rather than
hammering. Messaging is generous (30 burst, 5 per second sustained), so a
well-behaved bot never sees a limit.

Beyond the limits:

- Retire spent prompts. Disable or remove buttons the instant they have been
  answered, so nobody presses a stale one.
- Use `onlyUserId` on anything that acts on a single person's behalf in a shared
  conversation.
- Do not echo. The `message.created` webhook already excludes your bot's own
  messages, but if you reply to messages, exclude other bots too, or two bots in
  one group will talk to each other forever.
- Keep `customId` routing self-contained. Encode the id you need, do not rely on
  looking state up by message id alone, because messages can be deleted.
- A live card already edits in place. Do not also post a new message on every
  tick, and do not set `every` tighter than you need — ten seconds is the
  floor because a tighter loop is how you meet the rate limit.

## 11. Reference

### Bot authentication

```
Authorization: Bot yb_<token>
```

### Permission bits

Decimal string on the wire; here as `1 << n` for clarity.

| Bit | Name | Bit | Name |
|---|---|---|---|
| 0  | VIEW_CONVERSATION   | 14 | PIN_MESSAGES |
| 1  | READ_HISTORY        | 20 | START_CALL |
| 2  | SEND_MESSAGES       | 21 | JOIN_CALL |
| 3  | SEND_MEDIA          | 22 | END_CALL_FOR_ALL |
| 4  | SEND_VOICE_NOTES    | 23 | SCREEN_SHARE |
| 5  | SEND_STICKERS       | 30 | INVITE_MEMBERS |
| 6  | SEND_GIFS           | 31 | MANAGE_INVITES |
| 7  | SEND_POLLS          | 32 | KICK_MEMBERS |
| 8  | ADD_REACTIONS       | 33 | BAN_MEMBERS |
| 9  | MENTION_ALL         | 34 | MUTE_MEMBERS |
| 10 | EMBED_LINKS         | 35 | MANAGE_ROLES |
| 11 | EDIT_OWN_MESSAGES   | 36 | MANAGE_CONVERSATION |
| 12 | DELETE_OWN_MESSAGES | 37 | MANAGE_STICKERS |
| 13 | DELETE_ANY_MESSAGE  | 62 | ADMINISTRATOR |

`ADMINISTRATOR` implies everything. Ownership is a rank above roles: a member
can only act on members below them, so holding `KICK_MEMBERS` does not let you
kick the owner.

### Button object

```jsonc
{
  "type": "button",
  "customId": "string, <= 100 chars",   // echoed back, not a secret
  "label": "string, <= 80 chars",
  "style": "primary | secondary | success | danger",
  "disabled": false,
  "onlyUserId": "usr_... | null",        // restrict the press to one person
  "requiredPermissions": "decimal | null", // presser must hold these bits
  "staffOnly": false                     // yappy staff only
}
```

### Interaction response kinds

When acting on a press, a first-party handler returns one of:

- `update`: rewrite the message the button is on. The right default for a
  prompt, which should stop looking pressable once answered.
- `reply`: post a new message.
- `ack`: do neither.

Third-party bots achieve the same by calling the REST API with the bot token:
`update` is a `PATCH` on the message, `reply` is a `POST` of a new one.

### Webhook headers

```
Content-Type: application/json
X-Yappy-Signature: <hex HMAC-SHA256 of the raw body, keyed with your secret>
User-Agent: yappy-webhooks/1.0
```

### Asking yapper instead of reading this

Most of this page is also answerable from a DM with `@yapper`, which is where
you already are when you sign in to the portal. Every answer comes from `docs/`
or from the same constants the server authorises with, so it cannot tell you
something this page does not.

| Command | Answers |
|---|---|
| `/docs webhooks` | Searches these pages and links the section |
| `/error rate_limited` | What an `error.code` means, with a did-you-mean on a typo |
| `/perms 12884901888` | Decodes a bitfield into names |
| `/perms KICK_MEMBERS BAN_MEMBERS` | Builds the decimal string to put in `requiredPermissions` |
| `/webhook` | Your bots' webhook health, and a button that sends a real signed `webhook.test` delivery and tells you what came back |

`/webhook`'s test goes through the same delivery path a real event does — same
signature, same five-second timeout, same `User-Agent` — so a test that passes
is evidence about the real thing rather than about a special case. Which also
means you have to verify `X-Yappy-Signature` on it, like any other delivery.

yapper will also DM you unprompted, but only about your account's security (a
sign-in from an unfamiliar device, a suspension) and your bots' housekeeping (a
webhook that has stopped answering, a token that has not been rotated in a
year). The housekeeping ones carry an off switch; the security ones do not,
because an account holder is owed those.

### First-party vs third-party

`@yapper`, the built-in bot, runs inside the API process and answers
synchronously. Third-party bots receive events over a signed webhook and answer
asynchronously through the REST API. The contract is identical: same button
object, same authorisation rules, same interaction outcomes. The only difference
is the transport, and the in-process path is not a mechanism third-party bots
can use. Anything you can do, you do with your token over HTTPS.
