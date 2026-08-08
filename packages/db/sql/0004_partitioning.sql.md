# Partitioning the `messages` table

Not applied by `db:migrate`. This is the plan for when it is needed, written
down now so the schema does not drift into something that cannot be partitioned.

## When

Partition when `messages` passes roughly **100 million rows** or when index
maintenance starts showing up in write latency — whichever comes first. Below
that, a single table with the indexes in `0001_constraints.sql` is faster,
because every partition adds planning overhead to the one query that matters
(fetch the last 50 messages in a conversation).

Do not partition early. The common mistake is partitioning by `conversation_id`
hash, which makes the hot query fast but makes every cross-conversation
operation — search, the sync endpoint, the disappearing-message sweeper — fan
out across every partition.

## How

Range-partition by `created_at`, monthly. The access pattern is overwhelmingly
recent-first, so old partitions go cold and can move to cheaper storage or be
detached entirely.

```sql
-- messages becomes:
CREATE TABLE messages (
  ...same columns...
) PARTITION BY RANGE (created_at);

-- The primary key must include the partition key.
ALTER TABLE messages ADD PRIMARY KEY (id, created_at);

-- Likewise every unique index:
CREATE UNIQUE INDEX messages_conversation_seq_uq
  ON messages (conversation_id, seq, created_at);

CREATE TABLE messages_2026_08 PARTITION OF messages
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
```

### The two things that break

1. **Foreign keys pointing *at* `messages`.** Postgres cannot reference a
   partitioned table's non-unique key. `pinned_messages.message_id`,
   `message_reactions.message_id`, `message_attachments.message_id` and the
   self-references (`reply_to_id`, `thread_root_id`) all lose their FK. The
   integrity moves into the application, plus a nightly reconciliation job.
   This is the real cost of partitioning and the reason to delay it.

2. **`nonce` uniqueness.** The `(sender_id, nonce)` idempotency index becomes
   per-partition. A retry landing either side of a month boundary could
   duplicate. Fix by narrowing the index to the current and previous partition,
   or by moving idempotency keys to their own small unpartitioned table with a
   24-hour TTL — which is the better design anyway, since nonces are only
   meaningful for minutes.

## Partition maintenance

Use `pg_partman`, or a monthly pg-boss job that runs:

```sql
CREATE TABLE IF NOT EXISTS messages_YYYY_MM PARTITION OF messages
  FOR VALUES FROM ('YYYY-MM-01') TO ('YYYY-MM+1-01');
```

Always create partitions **two months ahead**. A missing partition is not a
degraded write, it is a hard insert failure — the whole app stops sending
messages at midnight on the 1st.

## What to do first instead

Cheaper wins, in the order worth trying:

1. `BRIN` index on `created_at` for the sweeper (tiny, and the data is
   naturally clustered by insertion time).
2. Move `message_revisions` and `call_events` to their own tablespace or purge
   them on a schedule — they grow fast and are read almost never.
3. Archive conversations with no activity in 18 months to cold storage.
