# Realtime protocol

One WebSocket per device. JSON frames. Opcode envelope, monotonic sequence
numbers, session resume.

```
ws://localhost:3001
```

## Frame

```jsonc
{
  "op": 5,              // opcode, always present
  "d":  { },            // payload
  "s":  42,             // sequence — Dispatch only
  "t":  "message.create", // event name — Dispatch only
  "nonce": "abc"        // correlation id — Command / CommandAck only
}
```

## Opcodes

| Op | Name | Direction | Purpose |
|---:|---|---|---|
| 0 | Hello | server → client | Heartbeat interval + session id |
| 1 | Identify | client → server | Authenticate a fresh session |
| 2 | Ready | server → client | Initial state delta |
| 3 | Heartbeat | client → server | Keepalive |
| 4 | HeartbeatAck | server → client | Keepalive ack |
| 5 | Dispatch | server → client | A named event |
| 6 | Resume | client → server | Replay a dropped session |
| 7 | Resumed | server → client | Replay complete |
| 8 | InvalidSession | server → client | Re-IDENTIFY (payload: resumable?) |
| 9 | Reconnect | server → client | Close and reconnect (deploy) |
| 10 | Command | client → server | Action with an ack |
| 11 | CommandAck | server → client | Result, echoes `nonce` |
| 12 | Error | server → client | Protocol-level error |

## Two sequence numbers — do not confuse them

- **`s`** on a Dispatch frame is a **per-socket-session** counter. It only means
  anything to RESUME.
- **`seq`** inside a message payload is the **per-conversation** message ordinal.
  It survives reconnects, drives ordering and unread counts, and is what
  `POST /v1/sync` and `?around=` take.

## Connect

```
server → { "op": 0, "d": { "sessionId": "…", "heartbeatIntervalMs": 41250, "protocolVersion": 1 } }

client → { "op": 1, "d": {
             "token": "<access token or gateway ticket>",
             "protocolVersion": 1,
             "client": { "platform": "android", "version": "1.0.0" },
             "presence": "online",
             "cursors": [ { "conversationId": "…", "seq": 4182 } ]
           } }

server → { "op": 2, "d": { "sessionId": "…", "conversations": [ … ],
                            "removedConversations": [ … ],
                            "resyncRequired": false } }
```

**Send `cursors`.** READY diffs against them and returns only conversations
whose `seq` moved. On an account with hundreds of chats this is the difference
between a multi-megabyte reconnect and a few kilobytes.

Identify within 20 seconds or the socket is closed.

## Heartbeat

Send `{"op": 3}` every `heartbeatIntervalMs`. Expect `{"op": 4}`. If no ack
arrives within ~15s, the connection is dead — a half-open TCP socket looks
perfectly alive to the OS, so this is the only thing that detects it.

Jitter the first heartbeat. Ten thousand clients reconnecting after a deploy and
then heartbeating in lockstep is a self-inflicted thundering herd.

## Resume

On an unclean disconnect, reconnect and send RESUME with the last `s` you
processed:

```
client → { "op": 6, "d": { "token": "…", "sessionId": "…", "seq": 42 } }
server → { "op": 7, "d": { "sessionId": "…", "seq": 57 } }   // 43–57 replayed first
```

Sessions stay resumable for **120 seconds** with a **256-event** replay buffer.
Beyond either, the server sends `InvalidSession` and you must IDENTIFY again —
then reconcile via `POST /v1/sync`, which is authoritative.

## Close codes

`< 4010` is retryable. `>= 4010` is fatal — do not reconnect in a loop.

| Code | Meaning | Retryable |
|---:|---|---|
| 4000 | Unknown error | yes |
| 4008 | Rate limited (>30 frames/sec) | yes, with backoff |
| 4009 | Session timeout | yes |
| 4010 | Authentication failed | no — get a new token |
| 4011 | Already authenticated | no — client bug |
| 4012 | Not authenticated | no — client bug |
| 4013 | Invalid payload | no — client bug |
| 4014 | Protocol version unsupported | no — force upgrade |
| 4015 | Session revoked | no — signed out elsewhere |
| 4016 | Account suspended | no |

## Commands

`{"op": 10, "nonce": "<id>", "d": { "c": "<name>", ... }}` → `{"op": 11, "nonce": "<id>", "d": {...}}`

| Command | Payload | Notes |
|---|---|---|
| `ping` | — | Returns `serverTime` |
| `typing.start` / `typing.stop` | `conversationId` | Never persisted; expires after 8s |
| `read.ack` | `conversationId`, `seq` | Monotonic and clamped to the conversation head |
| `presence.update` | `status`, `customStatus?` | |
| `conversation.subscribe` / `unsubscribe` | `conversationId` | Membership is re-checked |
| `presence.query` | `conversationId` | Who is online — pulled, not pushed |
| `call.signal` | `callId`, `payload`, `to?` | Opaque relay between participants |

Read acks over the socket rather than REST: they fire constantly and a
round-tripped HTTP request per scroll is wasteful.

## Events

**Messages** — `message.create`, `message.update`, `message.delete`,
`message.bulk_delete`
**Reactions** — `reaction.add`, `reaction.remove`, `reaction.clear`
**Pins** — `pin.add`, `pin.remove`
**Polls** — `poll.vote`, `poll.close`
**Conversations** — `conversation.create`, `conversation.update`,
`conversation.delete`, `conversation.state_update` *(your devices only)*
**Members** — `member.add`, `member.update`, `member.remove`
**Presence** — `typing.start`, `typing.stop`, `read.receipt`,
`delivery.receipt`, `presence.update`
**Users** — `user.update`, `relationship.update`, `block.update`
**Calls** — `call.ring`, `call.update`, `call.participant_update`, `call.end`,
`call.signal`
**Session** — `session.update`, `sticker_pack.update`, `resync`

The actor is excluded from their own events — the client already applied them
optimistically, and echoing back produces the "message appears, jumps,
reappears" flicker.

## Client rules that actually matter

1. **Reconnect with exponential backoff and jitter.** 1s → 2s → 4s → … capped at
   30s. Reset on a successful READY.
2. **Resume before you re-identify.** Cheaper for both sides.
3. **Never trust the socket for correctness.** It is a latency optimisation.
   Reconcile with `POST /v1/sync` on every foreground.
4. **Send a `nonce` on every message send** and render optimistically under it.
   A retry after a flaky send returns the original message instead of
   duplicating it.
5. **Respect `resyncRequired`.** It means the delta was too large to stream.
6. **Handle `op: 9` (Reconnect)** by disconnecting and reconnecting immediately.
   That is a rolling deploy, not a failure.
7. **Buffer outgoing frames while disconnected.** Do not drop a read-ack because
   the socket blinked.
