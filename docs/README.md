# yappy documentation

A map of what is here, and who each document is for.

## For developers building on yappy

- **[BOTS.md](BOTS.md)** is the bot developer guide. Registering a bot,
  authenticating, sending embeds and buttons, declaring slash commands,
  receiving events over a signed webhook, and the permission model. Start here
  if you are writing a bot.
- **[API.md](API.md)** is the REST reference: every endpoint, grouped by area,
  with the notes that are easy to get wrong (idempotency nonces, the two token
  types, cursor vs seq pagination).
- **[REALTIME_PROTOCOL.md](REALTIME_PROTOCOL.md)** is the WebSocket contract:
  opcodes, the resume handshake, and the events pushed over the gateway.

## For operators running an instance

- **[DEPLOY.md](DEPLOY.md)** takes a bare VPS to a running instance: DNS, the
  firewall, the environment file, `docker compose up`, and seeding the yapper
  bot.
- **[MODERATION.md](MODERATION.md)** is trust and safety operations: making
  staff, the Yappy Staff space, where reports go, and how suspensions work.

## For understanding the system

- **[ARCHITECTURE.md](ARCHITECTURE.md)** is the why: one Postgres and no Redis,
  the gapless `seq` counter, fan-out, authentication, the permission model,
  media, calling, and what is deliberately not built.
- **[../packages/db/sql/0004_partitioning.sql.md](../packages/db/sql/0004_partitioning.sql.md)**
  is the partitioning plan for when the messages table outgrows a single table.

## Conventions across the docs

- Errors are always `{ "error": { "code", "message", "details?", "retryAfter?" } }`.
  Switch on `code`, never on `message`. Messages are copy and will change.
- Permission bitfields travel as decimal strings, because the field runs past
  the 2^53 limit of a JavaScript number. Parse them as big integers.
- Two token types exist and are not interchangeable: an account access token
  (`Bearer`), a bot token (`Bot`), and a portal session token (`Bearer`, but
  accepted only by `/portal/*`). Each is rejected everywhere it does not belong.
