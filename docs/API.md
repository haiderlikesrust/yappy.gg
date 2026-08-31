# REST API

Base: `/v1`. Bearer auth. JSON in, JSON out.

Errors are always `{ "error": { "code", "message", "details?", "retryAfter?" } }`.
**Switch on `code`, never on `message`** — messages are copy and will change.

## Auth

Sign-in is email, password and username. There is no phone number and no OTP.
Passwords are hashed server-side with Argon2id; the plaintext never leaves the
request and is redacted from logs.

| Method | Path | Notes |
|---|---|---|
| POST | `/auth/register` | `{email, password, username, displayName?, client}`. 201 with a session. No onboarding step follows |
| POST | `/auth/login` | `{email, password, client}` → tokens. One message for wrong password and unknown account, so it is not an existence oracle |
| POST | `/auth/change-password` | `{currentPassword, newPassword}`. Bumps `token_epoch` and revokes every refresh token, then hands back a fresh session for the caller |
| GET | `/auth/username-available?username=` | |
| POST | `/auth/refresh` | `{refreshToken}` → rotated pair. The previous token stays valid for a 60s retry window |
| POST | `/auth/gateway-ticket` | 60s token for the WebSocket |
| POST | `/auth/logout` | This device |
| POST | `/auth/logout-all` | Bumps `token_epoch`, which kills every access token without a per-request lookup |

Registration returns a complete account, so `needsOnboarding` is always false.
A suspended account is refused at login after the password check, with the
suspension end date in the message, and is blocked from every write while the
suspension lasts.

There is no password reset yet. Building it needs a verified email address
first, or reset becomes a way to take an account by claiming its address.

## Users

| Method | Path | Notes |
|---|---|---|
| GET | `/users/me` | |
| PATCH | `/users/me` | Profile fields |
| PATCH | `/users/me/settings` | Merged, not replaced — partial updates are safe |
| PUT | `/users/me/presence` | |
| DELETE | `/users/me` | Soft delete, purged after 30 days |
| GET | `/users/:id` | Respects the target's privacy audiences |
| GET | `/users/by-username/:username` | |
| GET | `/users?q=&limit=` | Prefix match, then trigram |

## Social

| Method | Path | Notes |
|---|---|---|
| POST/DELETE | `/social/follow/:id` | Mutual follow = "contact" |
| GET | `/social/me/followers` · `/me/following` · `/me/contacts` | Cursor paginated |
| POST | `/social/block` · DELETE `/social/block/:id` · GET `/social/blocks` | |
| POST | `/social/contacts/sync` | `{phoneHashes[]}` — SHA-256 digests only |
| GET | `/social/notifications` · POST `/social/notifications/read` | |

## Conversations

| Method | Path | Notes |
|---|---|---|
| GET | `/conversations?archived=&cursor=` | Everything the list screen needs, denormalised |
| POST | `/conversations` | DM creation is idempotent via `dm_key` |
| GET/PATCH/DELETE | `/conversations/:id` | Delete = leave, unless you own it |
| PATCH | `/conversations/:id/state` | Mute, pin, archive, nickname, draft — private to you |
| GET/POST | `/conversations/:id/members` | |
| PATCH/DELETE | `/conversations/:id/members/:userId` | Role changes require outranking |
| POST | `/conversations/:id/transfer-ownership` | |
| POST/DELETE | `/conversations/:id/bans/:userId` | Survives rejoin; a kick does not |
| GET/POST | `/conversations/:id/invites` · DELETE `/invites/:code` | |
| GET | `/conversations/invites/:code` | Preview before joining |
| POST | `/conversations/invites/:code/join` | Row-locked, so a last-use race is safe |
| GET | `/conversations/discover` | Public groups and channels |
| GET | `/conversations/:id/presence` | Who is online here |

## Messages

| Method | Path | Notes |
|---|---|---|
| GET | `/conversations/:id/messages` | `?limit&before&after&around` — `around` centres a window for "jump to message" |
| POST | `/conversations/:id/messages` | **`nonce` required.** 201 = new, 200 = idempotent replay |
| GET/PATCH/DELETE | `/conversations/:id/messages/:messageId` | `?forEveryone=false` hides for you only |
| GET | `/conversations/:id/messages/:messageId/thread` | |
| POST | `/conversations/messages/forward` | Copies, not pointers |
| POST | `/conversations/:id/read` | Monotonic cursor |
| GET | `/conversations/:id/receipts?seq=` | "Seen by" |
| PUT/DELETE/GET | `/conversations/:id/messages/:messageId/reactions` | |
| PUT/DELETE/GET | `/conversations/:id/pins/:messageId` · `/pins` | |
| POST | `/conversations/:id/messages/:messageId/poll/vote` · `/poll/close` | Empty array retracts a vote |
| GET | `/conversations/:id/gallery?type=image` | |

Message body supports `text`, `image`, `video`, `audio` (voice notes), `file`,
`sticker`, `gif`, `location` (incl. live), `contact`, and `poll`, plus
`entities[]` for mentions, links, and inline formatting stored as offset spans.

### Mention entities

Offsets are UTF-16 code units into `content`, and the list must not overlap.
Each mention kind carries an **id, never a name**: people, roles and channels
all get renamed, and a message that still says the old one is a lie the client
cannot notice.

| `type` | Carries | Notifies | Resolved to |
|---|---|---|---|
| `mention` | `userId` | that person | the sender object already on the message |
| `mention_all` | — | everyone who can see the channel. Needs `MENTION_ALL` | — |
| `mention_role` | `roleId` | holders who can see the channel | `mentionedRoles[roleId]` → `{name, color}` |
| `mention_channel` | `channelId` | **nobody** — it is a signpost, not a ping | `mentionedChannels[channelId]` → `{title}` |

Two rules worth knowing before you build against these.

**A mention only reaches people who can see where it was sent.** Naming
somebody in a channel they cannot view creates no notification, no badge and no
inbox entry for them. Their name still renders; it just does not ring.

**`mentionedChannels` is resolved per reader, not per sender.** The same
message hands a title to somebody who can open that channel and nothing at all
to somebody who cannot — resolving it would disclose the channel's name and
existence. An unresolved id is not an error: render the span as the plain text
it was typed as, and do not offer a link.

## Media

```
POST /media/uploads      → { media, upload: { url, method, headers } }
PUT  <upload.url>        → send the bytes with exactly those headers
POST /media/:id/confirm  → { media }
```

Send `checksum` (SHA-256 hex) to get server-side dedupe — a repeat upload skips
the transfer entirely and comes back with `deduplicated: true`.

## Stickers & GIFs

| Method | Path | Notes |
|---|---|---|
| GET | `/stickers/installed` | The picker's source — all packs, all stickers, one query |
| GET | `/stickers/store?q=&cursor=` | |
| GET | `/stickers/packs/:idOrSlug` | Slug works, for share links |
| POST/DELETE | `/stickers/packs/:id/install` | |
| PUT | `/stickers/packs/order` | |
| GET | `/stickers/suggest?emoji=` | Emoji → sticker, the main discovery path |
| GET | `/stickers/recent` | |
| POST | `/stickers/packs` · POST/DELETE `/stickers/packs/:id/stickers` | Authoring |
| GET | `/gifs/search?q=&pos=&contentFilter=` | Proxied — the provider key stays server-side |
| GET/POST | `/gifs/recent` | |
| GET/PUT/DELETE | `/gifs/favorites` | |

## Calls

| Method | Path | Notes |
|---|---|---|
| POST | `/calls` | `{conversationId? \| inviteUserIds[], mode, nonce}` → `{call, token, url}` |
| POST | `/calls/:id/join` | Returns a fresh LiveKit token |
| POST | `/calls/:id/decline` · `/leave` · `/end` | |
| PATCH | `/calls/:id/state` | Mute / camera / screen share |
| GET | `/calls/:id` · `/calls` | History |

Starting a call in a conversation that already has one live returns that call
(`joined: "existing"`) rather than opening a second room.

## Sync

| Method | Path | Notes |
|---|---|---|
| POST | `/sync` | `{cursors[], messagesPerConversation, since?}` — the cold-start and foreground path |
| GET | `/sync/badge` | Whole-app badge in one query |

## Search

| Method | Path | Notes |
|---|---|---|
| GET | `/search/messages` | FTS with highlighted snippets; returns `seq` for deep-linking |
| GET | `/search?q=` | Unified — conversations and people |

## Custom emoji

Group-owned, usable only inside the group that owns them. In message text they
are the plain token `:name:`, so search, notifications and older clients keep
working.

| Method | Path | Notes |
|---|---|---|
| GET | `/conversations/:id/emojis` | Any member |
| POST | `/conversations/:id/emojis` | `{name, mediaId}`. Needs `MANAGE_STICKERS`. The media must be your own `emoji`-purpose upload, an image, under 512 KB |
| DELETE | `/conversations/:id/emojis/:emojiId` | Needs `MANAGE_STICKERS`. Soft delete, so `:name:` in old messages still resolves |

## Bots and the developer platform

See [BOTS.md](BOTS.md) for the full guide. The management surface is below, and
it is mounted twice: at `/apps` for an account access token, and identically at
`/portal/apps` for a developer-portal session.

| Method | Path | Notes |
|---|---|---|
| GET | `/apps/me` | Bot token only. The first call an SDK makes |
| GET | `/apps` | Your applications |
| POST | `/apps` | `{name, username, description?, isPublic}`. Returns the token once |
| PATCH | `/apps/:id` | Name, description, visibility |
| POST | `/apps/:id/token` | Rotate. The old token dies immediately |
| DELETE | `/apps/:id` | Revokes the token; keeps the username claimed |
| PUT | `/apps/:id/commands` | `{commands[]}`. Declares slash commands and their permission gates |
| PUT | `/apps/:id/webhook` | `{url}` sets and returns a signing secret once; `{url: null}` clears it |

Installing one into a space. The grant is a permission bitfield, issued by a
human who holds those bits themselves — a bot is never promoted up the member
ladder to get them. See [PERMISSIONS.md](PERMISSIONS.md#applications).

| Method | Path | Notes |
|---|---|---|
| GET | `/conversations/:id/apps` | Which bots are here and what each may do. Any member — what a program can do in your room is not a secret |
| PUT | `/conversations/:id/apps/:applicationId` | `{permissions}`. Install, or re-grant. Needs `MANAGE_ROLES` **and** `MANAGE_CONVERSATION` on the space, and you cannot grant a bit you do not hold. `ADMINISTRATOR` is refused to everyone, owner included. A bot cannot install a bot |
| DELETE | `/conversations/:id/apps/:applicationId` | Uninstall: the grant goes and so does the membership |

Interactions:

| Method | Path | Notes |
|---|---|---|
| POST | `/conversations/:id/messages/:messageId/interactions` | `{customId}`. Press a button. Authorised against the presser, never the bot |
| GET | `/conversations/:id/commands` | Slash commands offered here, already filtered to the caller's permissions |
| GET | `/conversations/:id/members/:userId/permissions` | A member's effective permission bitfield, for a bot to check an invoker |

## Developer portal

The portal is the browser surface for managing applications and, for staff,
moderation. Sign-in is passwordless: the page shows a code, the developer takes
it to `@yapper` in the app, and approves there.

| Method | Path | Notes |
|---|---|---|
| POST | `/portal/auth/start` | Unauthenticated. Returns `{userCode, pollToken, expiresIn}` |
| POST | `/portal/auth/poll` | `{pollToken}` → `pending` \| `awaiting_confirm` \| `approved` (+ token) \| `denied` \| `expired` \| `consumed` |
| GET | `/portal/me` | The session's user, including `isStaff` |
| GET | `/portal/staff/reports?status=` | Staff only. The queue with frozen evidence |
| POST | `/portal/staff/reports/:id/action` | Staff only. `{action: resolve\|dismiss\|suspend, note?, suspendDays?}` |

A portal token is rejected by the app API and an app token by the portal API.

## Devices, moderation, keys

| Method | Path | Notes |
|---|---|---|
| GET/DELETE | `/devices` · `/devices/:id` | The active-sessions screen |
| PUT/DELETE | `/devices/me/push` | Registering steals the token from any other device row |
| POST | `/moderation/reports` | Freezes an evidence snapshot at report time, and posts a card into the staff channel |
| GET | `/moderation/reports/mine` | |
| POST | `/keys/publish` · GET `/keys/count` · POST `/keys/claim` · GET `/keys/user/:id` | E2EE directory (not yet wired into messaging) |

## Pagination

- **Messages** paginate on `seq` — stable, and supports exact windows.
- **Everything else** uses opaque cursors. Pass `nextCursor` back as `cursor`;
  `null` means the end.

## Rate limits

429 with `Retry-After` and `error.retryAfter`. Token buckets, keyed per user,
per email, or per IP depending on the route. The tight ones: login 10 per email
per 5 min (plus a per-IP bucket that catches password spraying), register 5 per
IP per 10 min, portal grant 3 per IP per 2 min, contact sync 3 per hour, reports
10 per 50 min. Messaging limits (30 burst, 5 per second sustained) are set so a
fast typist never sees them.
