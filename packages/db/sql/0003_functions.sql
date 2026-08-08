-- Server-side functions for operations that must be atomic in one round trip.

-- ─── Message sequence allocation ────────────────────────────────────────────
-- The row-level lock taken by this UPDATE is what serialises concurrent
-- senders in the same conversation. It is held only for the remainder of the
-- transaction, so keep the send transaction short — this is the reason link
-- previews, push fan-out and transcoding are all deferred to the worker.

CREATE OR REPLACE FUNCTION allocate_message_seq(p_conversation_id uuid)
RETURNS bigint AS $$
DECLARE next_seq bigint;
BEGIN
  UPDATE conversations
     SET message_seq = message_seq + 1
   WHERE id = p_conversation_id
  RETURNING message_seq INTO next_seq;

  IF next_seq IS NULL THEN
    RAISE EXCEPTION 'conversation % not found', p_conversation_id
      USING ERRCODE = 'no_data_found';
  END IF;

  RETURN next_seq;
END;
$$ LANGUAGE plpgsql;

-- ─── Token-bucket rate limiting ─────────────────────────────────────────────
-- Stands in for Redis. Refill is computed from the elapsed time rather than
-- being ticked by a timer, so an idle bucket costs nothing and there is no
-- background job to keep running.
--
-- Returns (allowed, remaining, retry_after_seconds).

CREATE OR REPLACE FUNCTION consume_rate_limit(
  p_subject   text,
  p_action    text,
  p_capacity  double precision,
  p_refill_per_second double precision,
  p_cost      double precision DEFAULT 1
)
RETURNS TABLE (allowed boolean, remaining double precision, retry_after double precision) AS $$
DECLARE
  now_ts    timestamptz := clock_timestamp();
  bucket    rate_limits%ROWTYPE;
  elapsed   double precision;
  available double precision;
BEGIN
  SELECT * INTO bucket FROM rate_limits
   WHERE subject = p_subject AND action = p_action
     FOR UPDATE;

  IF NOT FOUND THEN
    available := p_capacity;
  ELSE
    elapsed   := EXTRACT(EPOCH FROM (now_ts - bucket.updated_at));
    available := LEAST(p_capacity, bucket.tokens + elapsed * p_refill_per_second);
  END IF;

  IF available >= p_cost THEN
    available := available - p_cost;
    INSERT INTO rate_limits (subject, action, tokens, updated_at, expires_at)
    VALUES (p_subject, p_action, available, now_ts,
            now_ts + make_interval(secs => GREATEST(p_capacity / NULLIF(p_refill_per_second, 0), 60)))
    ON CONFLICT (subject, action) DO UPDATE
      SET tokens = EXCLUDED.tokens,
          updated_at = EXCLUDED.updated_at,
          expires_at = EXCLUDED.expires_at;

    RETURN QUERY SELECT true, available, 0::double precision;
  ELSE
    -- Persist the refill even on rejection, otherwise a client hammering the
    -- endpoint keeps resetting its own clock and never recovers.
    INSERT INTO rate_limits (subject, action, tokens, updated_at, expires_at)
    VALUES (p_subject, p_action, available, now_ts,
            now_ts + make_interval(secs => GREATEST(p_capacity / NULLIF(p_refill_per_second, 0), 60)))
    ON CONFLICT (subject, action) DO UPDATE
      SET tokens = EXCLUDED.tokens,
          updated_at = EXCLUDED.updated_at,
          expires_at = EXCLUDED.expires_at;

    RETURN QUERY SELECT
      false,
      available,
      ((p_cost - available) / NULLIF(p_refill_per_second, 0))::double precision;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ─── Slow mode ──────────────────────────────────────────────────────────────
-- Per (conversation, user) cooldown, reusing the same bucket table.

CREATE OR REPLACE FUNCTION check_slow_mode(
  p_conversation_id uuid,
  p_user_id uuid,
  p_seconds int
)
RETURNS double precision AS $$
DECLARE last_at timestamptz;
BEGIN
  IF p_seconds <= 0 THEN RETURN 0; END IF;

  SELECT max(created_at) INTO last_at
    FROM messages
   WHERE conversation_id = p_conversation_id
     AND sender_id = p_user_id
     AND created_at > now() - make_interval(secs => p_seconds);

  IF last_at IS NULL THEN RETURN 0; END IF;

  RETURN GREATEST(0, p_seconds - EXTRACT(EPOCH FROM (now() - last_at)));
END;
$$ LANGUAGE plpgsql STABLE;

-- ─── Presence sweep ─────────────────────────────────────────────────────────
-- A gateway that dies without closing its sockets leaves rows behind. Called
-- on a schedule by the worker; also called with a node id at gateway startup
-- so a restarted node cleans up after its previous incarnation.

CREATE OR REPLACE FUNCTION sweep_presence(p_node_id text DEFAULT NULL)
RETURNS int AS $$
DECLARE removed int;
BEGIN
  WITH gone AS (
    DELETE FROM presence
     WHERE (p_node_id IS NOT NULL AND node_id = p_node_id)
        OR (p_node_id IS NULL AND expires_at < now())
    RETURNING user_id
  )
  SELECT count(*) INTO removed FROM gone;

  -- Users with no surviving device rows go offline, with a last-seen stamp.
  UPDATE users u
     SET presence_status = 'offline',
         last_seen_at = COALESCE(u.last_seen_at, now())
   WHERE u.presence_status <> 'offline'
     AND NOT EXISTS (SELECT 1 FROM presence p WHERE p.user_id = u.id);

  RETURN removed;
END;
$$ LANGUAGE plpgsql;

-- ─── Unread summary ─────────────────────────────────────────────────────────
-- One query for the whole app badge, used on cold start and on every resume.

CREATE OR REPLACE VIEW conversation_unread AS
SELECT
  m.user_id,
  m.conversation_id,
  GREATEST(c.message_seq - m.last_read_seq, 0) AS unread_count,
  m.mention_count,
  m.notification_level,
  m.muted_until,
  c.message_seq AS latest_seq,
  c.last_message_at
FROM conversation_members m
JOIN conversations c ON c.id = m.conversation_id
WHERE m.left_at IS NULL
  AND c.deleted_at IS NULL;
