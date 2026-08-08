# Architecture

## The shape of it

```
                    ┌──────────────────────────┐
   iOS / Android ───┤  api      (Fastify, REST) │──┐
        │           └──────────────────────────┘  │
        │           ┌──────────────────────────┐  │   ┌──────────────┐
        └───────────┤  gateway  (WebSocket)     │──┼───┤  PostgreSQL  │
                    └──────────────────────────┘  │   └──────────────┘
                    ┌──────────────────────────┐  │      ▲   ▲   ▲
                    │  worker   (pg-boss)       │──┘      │   │   │
                    └──────────────────────────┘         data │ queue
                                                          LISTEN/NOTIFY
   media ──► S3 / R2 (presigned, direct)
   calls ──► LiveKit SFU (media never touches this backend)
```

Three processes, one database. Each scales horizontally and independently: the
API is stateless, the gateway holds sockets, the worker holds nothing.

## Why one database and no Redis

The obvious build for this is Postgres + Redis: Redis for pub/sub, presence,
rate limits, and a job queue. This system uses Postgres for all four.

What that buys:

- **Transactional events.** `pg_notify` fires on commit. Publishing a
  `message.create` inside the same transaction as the message insert means the
  event fires if and only if the row committed. With Redis you need a
  transactional outbox and a relay process to get the same guarantee — that is
  strictly more machinery than the thing it replaces.
- **One system to operate.** One connection string, one backup, one failover
  story, one thing to monitor. At this stage that is worth more than raw
  throughput.
- **No cache-coherence class of bug.** There is no second copy of the truth to
  go stale.

What it costs, and where the ceiling is:

| Concern | Limit | What to do at the limit |
|---|---|---|
| `pg_notify` throughput | ~10–20k notifies/sec on one primary | Shard topics across read replicas, or swap `PgBus` for a Redis/NATS implementation |
| 8000-byte payload cap | Large events | Already handled — oversized events spill to `bus_overflow` and notify a pointer |
| Presence writes | One row per connected device, TTL-refreshed in bulk every 30s | Fine to ~100k concurrent; past that move presence to Redis |
| Rate limits | One `UPDATE … RETURNING` per check, with a per-node cache in front | The cache already absorbs most of it |

The swap path is deliberate. `PgBus` in `packages/db/src/bus.ts` exposes
`publish` / `subscribe` / `unsubscribe` and nothing else. A `RedisBus` with the
same three methods is a drop-in — no route, service, or gateway code changes.
Same for the queue: `app.enqueue` is the only thing that knows pg-boss exists.

**The load-bearing decision that makes this safe:** the realtime layer is never
the source of truth. Every client reconciles by `seq` on reconnect through
`POST /v1/sync`. A dropped notify costs a few hundred milliseconds of latency,
never a lost message. That property is what lets the event bus be the cheap,
replaceable part.

## Message ordering: the `seq` counter

Every conversation carries `message_seq`. Sending allocates the next value:

```sql
UPDATE conversations SET message_seq = message_seq + 1
 WHERE id = $1 RETURNING message_seq;
```

The row lock serialises concurrent senders in that conversation, so the sequence
is **gapless and total**. This one column powers:

- ordering (no clock skew, no ties — UUIDv7 is only millisecond-precise)
- unread counts: `conversation.message_seq - member.last_read_seq`
- read receipts: one cursor per member, not one row per (message, member)
- delta sync: "give me everything after 4,182"
- history visibility: a member added later gets `history_start_seq` and cannot
  page back past it

**Per-message read receipts are the trap.** They are O(members × messages) and
will bury the database in a table nothing else needs. One cursor per member
gives the same UI for a rounding error of the cost.

The cost of `seq`: the send transaction holds a conversation-level lock. So it
is kept short — link previews, push fan-out, and transcoding all happen after
commit, in the worker.

## Fan-out

Conversation events publish **once** to `c_<conversation_id>`. A gateway node
subscribes to that topic while it holds at least one connected member, with
reference counting and a 30-second unsubscribe grace period (mobile clients
reconnect constantly; churning LISTEN/UNLISTEN on every tunnel is waste).

Personal events — a follow, a block, another of your devices changing a setting,
an incoming call — publish to `u_<user_id>`.

Calls ring on the **user** topic, not the conversation topic, because the device
that most needs to ring is the one with no conversation subscribed yet.

## Authentication

Two tokens:

- **Access** — 15-minute JWT. Carries `did` (device id) and `ep` (the user's
  `token_epoch`). Bumping `token_epoch` invalidates every outstanding token for
  that user with no revocation list. That is "log out everywhere".
- **Refresh** — opaque 256-bit random, only its SHA-256 stored, rotated on every
  use. The *previous* hash is accepted once, because a client that loses the
  response to a dropped connection and retries must not be logged out. Reuse of
  anything older is treated as theft and kills the session.

A third, `gateway ticket`, is a 60-second token scoped to opening the WebSocket
— because gateway URLs carry it as a query parameter and query strings end up in
proxy logs.

## Permissions

A 64-bit field per member, resolved as:

```
conversation base → role defaults → member allow → member deny → active mute
```

Collapsing to one integer means every authorisation check — on every send, edit,
reaction, and pin — is a bitwise AND rather than a join. Serialised as a decimal
*string* in JSON, since JS numbers lose precision past 2^53.

All of it goes through `apps/api/src/lib/access.ts`. No route reads
`conversation_members` to make an authorisation decision. One place to audit.

Note that `requireMember` throws **404, not 403**, for a non-member. Confirming
that a conversation exists to someone outside it leaks group membership to
anyone who can guess an id.

## Media

Presigned direct-to-S3. Bytes never transit Node — a 100 MB video through the
API process would occupy a worker for the length of the upload and double the
egress bill.

```
POST /media/uploads   → row in `pending` + presigned PUT (length and type bound
                        into the signature, so a 1 KB avatar presign cannot be
                        used to upload 2 GB)
PUT  <presigned url>  → client → S3/R2 directly
POST /media/:id/confirm → HEAD the object, trust the bucket's size over the
                          client's claim, queue processing
```

Unconfirmed uploads are swept after two hours. Media is reference-counted by
trigger and only collectable at zero — doing that in application code leaks
storage every time a request fails halfway.

Content is addressed by SHA-256, so the same meme sent 400 times is stored once.

## Calling

LiveKit is the SFU. It carries media; this backend carries everything LiveKit
has no concept of: who is blocked, who is an admin, which of a user's four
devices should ring, and whether a phone that never responded declined or was
simply asleep.

State machine: `ringing → active → ended`. It goes active on the first join by
someone other than the initiator, and ends when the last participant leaves,
when everyone declines, or when the ring timeout fires.

**The ring timeout is a scheduled job, not a client timer.** The one client
guaranteed not to fire a timer is the one that crashed. A reconciliation sweep
also force-ends calls marked active with nobody joined — otherwise a dead node
mid-hangup leaves a "call in progress" banner in the conversation forever.

Every call writes a summary message into the thread when it ends, so missed
calls are something you can scroll back to.

## Privacy

- **Contact sync** never receives a phone number. The client sends SHA-256
  digests; the server re-derives a peppered HMAC (pepper stored in
  `server_secrets`, so it is backed up with the data it protects) and matches.
  This is not a strong PSI protocol — a malicious client can still confirm
  numbers it already has — but that is the bound every mainstream messenger
  operates under, and the rate limit (3/hour) is what makes bulk enumeration
  impractical.
- **Presence collapses together.** Hiding last-seen while still reporting
  "online" defeats the setting, so `toFullUser` suppresses both or neither.
- **Read receipts are bidirectional.** Someone who disables them is also
  excluded from the "seen by" list.
- **Blocking** severs follows in both directions by trigger, and is enforced in
  SQL rather than as a post-filter — a post-filter still leaks existence through
  result counts and timing.

## E2EE

`packages/db/src/schema/crypto.ts` ships a key directory (identity keys, signed
prekeys, one-time prekeys, safety-number verification) that nothing currently
uses. Messages today are server-visible, which is what makes search, link
previews, push previews, and moderation work.

It ships now because key distribution is the part that **cannot** be
retrofitted. Adding it later means every existing device has no identity key and
every historical conversation has no session — a migration users experience as
"all my old messages are gone". With the directory in place, opt-in encrypted
DMs become a feature flag rather than a rewrite.

## What is not built

Stated plainly rather than left to be discovered:

- **Posts / stories / a public feed.** The social graph (`follows`, mutuals) is
  here and the request listed only messaging features, so the feed itself is
  out of scope. It is a separate module, not a change to this one.
- **Transcoding.** `media.process` marks lifecycle and logs a hand-off point.
  ffmpeg in-process would block the event loop; production dispatches to a
  container pool or a managed pipeline.
- **A moderation console.** Reports, evidence snapshots, the action log, and the
  triage queue exist. The UI on top of them does not.
- **Automated content classification.** `moderation.triage` is a hook that
  currently only escalates by report reason.
- **Tests.** No test suite is included.

## Scaling checklist, in order

1. Read replicas for search and history (already the heaviest reads).
2. Move presence and rate limits to Redis — the two highest-frequency writes,
   and both are already behind an interface.
3. Swap `PgBus` for Redis/NATS when notify throughput becomes the constraint.
4. Partition `messages` by month — see `packages/db/sql/0004_partitioning.sql.md`
   for the DDL and, more importantly, for what breaks (foreign keys pointing at
   `messages`, and nonce uniqueness across a partition boundary).
5. Mirror messages into OpenSearch when Postgres FTS stops keeping up.
