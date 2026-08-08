# yappy.gg — backend

Chat backend for an iOS/Android social app. Groups, DMs, reactions, pinned
messages, stickers, GIFs, threads, polls, voice notes, 1:1 and group calls,
push, search, moderation.

TypeScript · Fastify · PostgreSQL · Drizzle · LiveKit. **No Redis** — Postgres
carries the event bus (LISTEN/NOTIFY), the job queue (pg-boss), presence, and
rate limiting. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for why, what it
costs, and the swap path.

## Layout

```
packages/shared    protocol, zod contracts, permission bitfield, error codes
packages/db        Drizzle schema, handwritten SQL, the Postgres event bus
apps/api           Fastify REST
apps/gateway       WebSocket gateway
apps/worker        pg-boss jobs — push, media, links, sweepers, call timeouts
android/           Kotlin + Compose client, neumorphic UI, light and dark
```

The Android app has its own [README](android/README.md) covering the design
system and how to point it at a local backend.

## Running it

Requires Node 22+, pnpm 9+, and Postgres 17. Docker Compose brings up Postgres,
MinIO (S3-compatible), and a LiveKit dev server.

```bash
pnpm install
```

```bash
cp .env.example .env
```

```bash
docker compose up -d
```

If you are using a local Postgres instead of the container, create the database
first — the credentials in `.env.example` are `postgres:yappy_dev`:

```bash
psql -U postgres -c "CREATE DATABASE yappy"
```

Then generate and apply the schema:

```bash
pnpm db:generate && pnpm db:migrate
```

Optionally load a development cast (four users, a group with history, a DM):

```bash
pnpm db:seed
```

```bash
pnpm dev
```

That starts the API on `:3000`, the gateway on `:3001`, and the worker. Health
checks are at `/health` and `/ready` on both HTTP services.

### Verifying it works

With all three running:

```bash
pnpm smoke
```

Exercises the real stack end to end — OTP signup for three users, refresh-token
rotation and its retry window, DM idempotency, group creation under the
`contacts` privacy audience, gapless `seq` ordering, nonce idempotency on send,
edit and permission guards, reaction rollups, pins, poll tallies, read cursors,
delta sync, full-text search, and a WebSocket client that receives a
`message.create` pushed over LISTEN/NOTIFY. 33 checks.

Verified against PostgreSQL 18.1 and Node 23.

### Migrations

`pnpm db:migrate` runs three phases in order:

1. `packages/db/sql/0000_extensions.sql` — citext and pg_trgm, needed *before*
   the generated migrations declare columns of those types.
2. Drizzle's generated migrations — tables, columns, indexes.
3. The remaining `packages/db/sql/*.sql` — constraints, the generated tsvector
   column, triggers, and functions. These are idempotent and re-run every time;
   they are the source of truth for anything Drizzle's DSL cannot express.

## Try it

```bash
curl -X POST localhost:3000/v1/auth/otp/request -H 'content-type: application/json' -d '{"phone":"+15551234567"}'
```

With `SMS_PROVIDER=console` the code is printed in the worker's logs.

```bash
curl -X POST localhost:3000/v1/auth/otp/verify -H 'content-type: application/json' -d '{"phone":"+15551234567","code":"123456","client":{"platform":"android","version":"1.0.0"}}'
```

## Docs

- [Architecture](docs/ARCHITECTURE.md) — the decisions and their trade-offs
- [Realtime protocol](docs/REALTIME_PROTOCOL.md) — WebSocket opcodes, resume, events
- [REST API](docs/API.md) — endpoint reference
- [Partitioning plan](packages/db/sql/0004_partitioning.sql.md) — when, how, and what breaks

## Before production

`apps/api/src/env.ts` refuses to boot in production with development secrets or
a console SMS provider. Beyond that:

- Real `JWT_SECRET` (`openssl rand -base64 48`) and LiveKit credentials
- APNs (.p8) and FCM service-account credentials
- S3/R2 instead of MinIO, with a lifecycle rule on the `attachment/` prefix
- Twilio and Resend keys for OTP delivery
- A transcode pipeline — `media.process` currently marks lifecycle and logs a
  hand-off point rather than running ffmpeg in-process

## Not included

Deliberately, and listed so it is not discovered later: a posts/stories feed
(the follow graph is here, the feed is not), media transcoding, a moderation
console UI, automated content classification, and tests. The full list with
reasoning is at the end of [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
