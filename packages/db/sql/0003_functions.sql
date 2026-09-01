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

-- The four-argument form used by the message send path. Same lock, same seq,
-- but the last-message columns are stamped in the SAME statement — the send
-- used to issue a second UPDATE of this row inside the lock window, which was
-- one more round trip, one more dead tuple on the hottest row in the system,
-- and a second firing of touch_updated_at, per message. A distinct arity
-- rather than defaults, so the one-argument callers above stay unambiguous.
-- now() here equals the message row's created_at default: both are the
-- transaction timestamp.
CREATE OR REPLACE FUNCTION allocate_message_seq(
  p_conversation_id uuid,
  p_message_id uuid,
  p_sender_id uuid,
  p_preview text
) RETURNS bigint AS $$
DECLARE next_seq bigint;
BEGIN
  UPDATE conversations
     SET message_seq = message_seq + 1,
         last_message_id = p_message_id,
         last_message_at = now(),
         last_message_sender_id = p_sender_id,
         last_message_preview = p_preview
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

-- ─── Channel visibility ─────────────────────────────────────────────────────
--
-- Who can actually see a conversation, answered in SQL.
--
-- Until this existed, `loadMemberContext` in apps/api/src/lib/access.ts was the
-- only thing in the system that could answer the question, and it answers it
-- for exactly one (conversation, user) pair at a time, in TypeScript. Every
-- fan-out path therefore substituted the question it *could* ask in SQL --
-- "is this person in the space" -- for the one it meant. Those are the same
-- answer right up until a channel restricts itself, which is the moment it
-- matters: the gateway subscribed every space member to every channel topic,
-- the push worker sent every space member the message text, and the mention
-- fan-out wrote every space member a row. A private channel was private only
-- in the REST read paths.
--
-- This mirrors `effectivePermissions` in packages/shared/src/permissions.ts
-- statement for statement. It is a second implementation of a security
-- decision, which is a thing worth being nervous about, so:
--
--   * the constants below are asserted against the TypeScript ones at API
--     boot (apps/api/src/lib/permissionParity.ts); the API refuses to start
--     if they have drifted;
--   * every step is commented against the line it mirrors;
--   * `restricted` is reproduced faithfully, including the fact that it
--     ignores base and overwrites entirely. That may well be wrong in the
--     model, but it is what the REST layer enforces today, and a fan-out that
--     disagrees with the REST layer is a worse bug than an odd rule applied
--     consistently.
--
-- Mute is deliberately absent: it strips only SEND_BUNDLE, MENTION_ALL and
-- START_CALL, and can never affect VIEW_CONVERSATION.

CREATE OR REPLACE FUNCTION permission_constants()
RETURNS TABLE (name text, value bigint) LANGUAGE sql IMMUTABLE AS $fn$
  SELECT * FROM (VALUES
    ('ALL_PERMISSIONS',    4611686292247314431::bigint),
    ('ADMINISTRATOR',      4611686018427387904::bigint),
    ('VIEW_CONVERSATION',                    1::bigint),
    ('role.owner',         4611686292247314431::bigint),
    ('role.admin',                273819926527::bigint),
    ('role.moderator',             22564339711::bigint),
    ('role.member',                          0::bigint),
    ('role.restricted',                2097155::bigint),
    ('base.dm',                       11558399::bigint),
    ('base.group',                  1085283839::bigint),
    ('base.channel',                1085283839::bigint),
    ('base.space',                  1075838979::bigint)
  ) AS t(name, value);
$fn$;

-- The permission bits every member of the owning scope effectively holds in
-- `p_conversation`. Callers filter for the bit they care about.
CREATE OR REPLACE FUNCTION conversation_permissions(p_conversation uuid)
RETURNS TABLE (user_id uuid, permissions bigint)
LANGUAGE sql STABLE AS $fn$
  WITH k AS (
    SELECT
      (SELECT value FROM permission_constants() WHERE name = 'ALL_PERMISSIONS') AS all_perms,
      (SELECT value FROM permission_constants() WHERE name = 'ADMINISTRATOR')   AS admin_bit,
      (SELECT value FROM permission_constants() WHERE name = 'role.restricted') AS restricted
  ),
  ch AS (
    SELECT c.id,
           c.parent_id,
           coalesce(c.parent_id, c.id) AS scope_id,
           -- base_permissions is nullable; null means "the default for this
           -- type", exactly as effectivePermissions reads it (line 212).
           coalesce(c.base_permissions, (
             SELECT value FROM permission_constants() WHERE name = 'base.' || c.type::text
           )) AS base
      FROM conversations c
     WHERE c.id = p_conversation AND c.deleted_at IS NULL
  ),
  -- Authority is the SPACE's row for a channel, the conversation's own
  -- otherwise (access.ts:146).
  auth AS (
    SELECT pm.user_id, pm.role::text AS role, pm.allow, pm.deny
      FROM ch
      JOIN conversation_members pm
        ON pm.conversation_id = ch.scope_id
       AND pm.left_at IS NULL
  ),
  -- Named roles (space-scoped) and what THIS channel says about them.
  role_masks AS (
    SELECT mr.user_id,
           coalesce(bit_or(r.permissions), 0::bigint) AS role_perms,
           coalesce(bit_or(o.allow),       0::bigint) AS role_allow,
           coalesce(bit_or(o.deny),        0::bigint) AS role_deny
      FROM ch
      JOIN member_roles mr      ON mr.conversation_id = ch.scope_id
      JOIN conversation_roles r ON r.id = mr.role_id
      LEFT JOIN conversation_role_overwrites o
             ON o.role_id = mr.role_id AND o.conversation_id = ch.id
     GROUP BY mr.user_id
  ),
  inputs AS (
    SELECT a.user_id,
           a.role,
           ch.base,
           coalesce(rm.role_perms, 0::bigint) AS role_perms,
           coalesce(rm.role_allow, 0::bigint) AS role_allow,
           coalesce(rm.role_deny,  0::bigint) AS role_deny,
           -- The channel's own row still applies where it exists: that is how
           -- one person is muted in #general and nowhere else (access.ts:177).
           coalesce(cm.allow, 0::bigint)
             | CASE WHEN ch.parent_id IS NOT NULL THEN a.allow ELSE 0::bigint END AS m_allow,
           coalesce(cm.deny, 0::bigint)
             | CASE WHEN ch.parent_id IS NOT NULL THEN a.deny  ELSE 0::bigint END AS m_deny,
           (SELECT value FROM permission_constants() WHERE name = 'role.' || a.role) AS ladder
      FROM auth a
      CROSS JOIN ch
      LEFT JOIN role_masks rm ON rm.user_id = a.user_id
      LEFT JOIN conversation_members cm
             ON cm.conversation_id = ch.id AND cm.user_id = a.user_id
  ),
  -- permissions.ts:222 -- owner is absolute; everyone else is
  -- base | ladder | named roles.
  tier1 AS (
    SELECT i.*, k.all_perms, k.admin_bit, k.restricted,
           CASE WHEN i.role = 'owner' THEN k.all_perms
                ELSE i.base | i.ladder | i.role_perms END AS p1
      FROM inputs i CROSS JOIN k
  ),
  -- permissions.ts:230 -- the ADMINISTRATOR bypass runs BEFORE the overwrites,
  -- so a channel overwrite cannot lock an administrator out of their own space.
  tier2 AS (
    SELECT t.*, CASE WHEN (t.p1 & t.admin_bit) <> 0 THEN t.all_perms ELSE t.p1 END AS p2
      FROM tier1 t
  )
  SELECT user_id,
         CASE
           -- permissions.ts:214 -- restricted is an absolute, computed from
           -- RESTRICTED and the per-member pair alone.
           WHEN role = 'restricted' THEN (restricted | m_allow) & ~m_deny
           -- permissions.ts:243-247 -- role deny, then role allow, then the
           -- per-member pair last: the narrower statement is the more
           -- deliberate one.
           ELSE ((((p2 & ~role_deny) | role_allow) | m_allow) & ~m_deny)
         END AS permissions
    FROM tier2;
$fn$;

-- Everyone who can see `p_conversation`. The final test is `has()`
-- (permissions.ts:257): ADMINISTRATOR short-circuits, so an administrator
-- whose VIEW bit an overwrite stripped still passes.
CREATE OR REPLACE FUNCTION conversation_viewers(p_conversation uuid)
RETURNS TABLE (user_id uuid)
LANGUAGE sql STABLE AS $fn$
  SELECT p.user_id
    FROM conversation_permissions(p_conversation) p,
         (SELECT
            (SELECT value FROM permission_constants() WHERE name = 'ADMINISTRATOR')     AS admin_bit,
            (SELECT value FROM permission_constants() WHERE name = 'VIEW_CONVERSATION') AS view_bit
         ) k
   WHERE (p.permissions & k.admin_bit) <> 0
      OR (p.permissions & k.view_bit) = k.view_bit;
$fn$;

CREATE OR REPLACE FUNCTION can_view_conversation(p_conversation uuid, p_user uuid)
RETURNS boolean LANGUAGE sql STABLE AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM conversation_viewers(p_conversation) v WHERE v.user_id = p_user
  );
$fn$;

-- Is this conversation restricted at all?
--
-- The fast path everything leans on. A conversation with no lowered base, no
-- role overwrite, and no per-member allow/deny or restricted member grants its
-- base to every member of the scope -- so "member of the space" and "can see
-- this channel" really are the same set. That is why the old queries were
-- right for years and then quietly stopped being right the day private
-- channels shipped.
--
-- Callers use this to skip the composition entirely for the overwhelming
-- majority of conversations, and pay for `conversation_viewers` only where the
-- answer can actually differ.
CREATE OR REPLACE FUNCTION conversation_is_gated(p_conversation uuid)
RETURNS boolean LANGUAGE sql STABLE AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM conversations c
     WHERE c.id = p_conversation
       AND (
         c.base_permissions IS NOT NULL
         OR EXISTS (SELECT 1 FROM conversation_role_overwrites o WHERE o.conversation_id = c.id)
         OR EXISTS (
              SELECT 1 FROM conversation_members d
               WHERE d.conversation_id IN (c.id, coalesce(c.parent_id, c.id))
                 AND (d.deny <> 0 OR d.allow <> 0 OR d.role = 'restricted')
            )
       )
  );
$fn$;
