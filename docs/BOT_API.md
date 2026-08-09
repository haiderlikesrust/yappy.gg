# Bot API reference

Every endpoint a bot token can call, grouped by what you are trying to do.

The base URL is `https://api.yappy.gg/v1`. Every request carries your bot token
in the `Bot` scheme:

```
Authorization: Bot yb_9c1f8a2b...
```

A bot is an ordinary account. That means these endpoints are the same ones a
person's client calls, and your bot reaches them under the same rules: it must
be a member of the conversation, and it must hold the permission the action
requires. There is no privileged bot path. See
[the permission reference](PERMISSIONS.md) for the bits, and
[errors and rate limits](ERRORS.md) for what comes back when a call is refused.

## Your application

| Method | Path | What it does |
|---|---|---|
| GET | `/apps/me` | The bot's own application and user record. The usual boot call |
| PUT | `/apps/:id/commands` | Replace the declared slash commands. Sending an empty array withdraws them all |
| PUT | `/apps/:id/webhook` | Set the delivery URL. Returns the signing secret exactly once |
| POST | `/apps/:id/token` | Rotate the token. Immediate, with no grace window |

`:id` is the application id from `/apps/me`, not the bot's user id. The two are
different records and mixing them up gives a 404.

## Conversations

| Method | Path | What it does |
|---|---|---|
| GET | `/conversations` | The conversations the bot is in |
| GET | `/conversations/:id` | One conversation, including the bot's own permissions in it |
| GET | `/conversations/:id/members/:userId/permissions` | Someone's effective permissions. Use before acting on a typed command |

A conversation the bot is not in answers 404 rather than 403. Non-membership
should not confirm that a conversation exists.

## Messages

| Method | Path | What it does |
|---|---|---|
| GET | `/conversations/:id/messages` | History, newest first, cursor paginated |
| POST | `/conversations/:id/messages` | Post. Requires `nonce`. 201 for new, 200 when the nonce replays |
| GET | `/conversations/:id/messages/:messageId` | One message |
| PATCH | `/conversations/:id/messages/:messageId` | Edit. A bot may only edit its own messages |
| DELETE | `/conversations/:id/messages/:messageId` | Delete |
| GET | `/conversations/:id/messages/:messageId/thread` | Replies to a message |

`nonce` is your idempotency key and it is required. Derive it from the logical
send rather than generating a fresh random value per attempt, or a retry after a
dropped connection posts a duplicate instead of returning the original.

Embeds and components are accepted on `POST` and `PATCH`, and only from bots.
The server refuses them from a human sender, because a rich card anyone could
author is the most effective phishing surface a chat product has.

## Reactions and pins

| Method | Path | What it does |
|---|---|---|
| PUT | `/conversations/:id/messages/:messageId/reactions` | Add a reaction |
| DELETE | `/conversations/:id/messages/:messageId/reactions` | Remove yours |
| GET | `/conversations/:id/messages/:messageId/reactions` | Who reacted with what |
| PUT | `/conversations/:id/pins/:messageId` | Pin. Needs `PIN_MESSAGES` |
| DELETE | `/conversations/:id/pins/:messageId` | Unpin |
| GET | `/conversations/:id/pins` | The pinned messages |

## Commands and interactions

| Method | Path | What it does |
|---|---|---|
| GET | `/conversations/:id/commands` | The commands offered in this conversation, already filtered by the caller's permissions |
| POST | `/conversations/:id/messages/:messageId/interactions` | Register a button press. Clients call this; a bot rarely needs to |

A button press reaches your bot as an `interaction.pressed` webhook. You act on
it by editing the message with `PATCH`, which is how a third-party bot performs
the `update` outcome. Posting a new message is the `reply` outcome. Doing
neither is `ack`.

## Polls

| Method | Path | What it does |
|---|---|---|
| POST | `/conversations/:id/messages/:messageId/poll/vote` | Cast a vote |
| POST | `/conversations/:id/messages/:messageId/poll/close` | Close a poll you created |

## Webhook deliveries

Not an endpoint you call, but the other half of the contract. yappy POSTs to
your URL for two event types:

| Type | When |
|---|---|
| `message.created` | Any message in a conversation the bot is in, except its own, so you cannot loop |
| `interaction.pressed` | One of your buttons was pressed |

Every delivery carries `X-Yappy-Signature`, the hex HMAC-SHA256 of the raw
request body keyed with your signing secret. Verify it before trusting the
payload, over the bytes as received and before any JSON parsing. Deliveries are
retried five times with exponential backoff, and the handler has five seconds to
answer, so acknowledge first and do slow work after.

The `interaction.pressed` payload includes the invoker's `permissions` and
`isStaff` so you can make your own authorisation decision without a second call.

## What bots cannot do

- Create accounts, sign in, or act on behalf of a user. A bot token authenticates
  the bot and nothing else.
- Post embeds or components as anyone other than themselves.
- Edit or delete another account's messages, regardless of permissions held.
- Use `staffOnly` on buttons. That flag is reserved for yappy staff tooling.
- Join a conversation uninvited. Someone with `INVITE_MEMBERS` adds the bot, or
  it joins a public group.
