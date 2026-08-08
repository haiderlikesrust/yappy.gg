# REST API

Base: `/v1`. Bearer auth. JSON in, JSON out.

Errors are always `{ "error": { "code", "message", "details?", "retryAfter?" } }`.
**Switch on `code`, never on `message`** — messages are copy and will change.

## Auth

| Method | Path | Notes |
|---|---|---|
| POST | `/auth/otp/request` | `{phone \| email, purpose}`. Never reveals whether the account exists |
| POST | `/auth/otp/verify` | `{phone \| email, code, client}` → tokens + `needsOnboarding` |
| POST | `/auth/complete-profile` | `{username, displayName, avatarMediaId?}` |
| GET | `/auth/username-available?username=` | |
| POST | `/auth/refresh` | `{refreshToken}` → rotated pair |
| POST | `/auth/gateway-ticket` | 60s token for the WebSocket |
| POST | `/auth/logout` | This device |
| POST | `/auth/logout-all` | Bumps `token_epoch` — kills every token |

Until `complete-profile` succeeds, `username` is null and every
`authenticateOnboarded` route returns 403.

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

## Devices, moderation, keys

| Method | Path | Notes |
|---|---|---|
| GET/DELETE | `/devices` · `/devices/:id` | The active-sessions screen |
| PUT/DELETE | `/devices/me/push` | Registering steals the token from any other device row |
| POST | `/moderation/reports` | Freezes an evidence snapshot at report time |
| GET | `/moderation/reports/mine` | |
| POST | `/keys/publish` · GET `/keys/count` · POST `/keys/claim` · GET `/keys/user/:id` | E2EE directory (not yet wired into messaging) |

## Pagination

- **Messages** paginate on `seq` — stable, and supports exact windows.
- **Everything else** uses opaque cursors. Pass `nextCursor` back as `cursor`;
  `null` means the end.

## Rate limits

429 with `Retry-After` and `error.retryAfter`. Token buckets, per user or IP.
The tight ones: OTP request 3 per 6 min, OTP verify 5 per 5 min, contact sync
3/hour, reports 10 per 50 min. Messaging limits (30 burst, 5/sec sustained) are
set so a fast typist never sees them.
