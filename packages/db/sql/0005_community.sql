-- Shared read boundary for personal collections, reminders and catch-up.
CREATE OR REPLACE FUNCTION can_read_message(p_message uuid, p_user uuid)
RETURNS boolean LANGUAGE sql STABLE AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM messages m
    JOIN conversations c ON c.id = m.conversation_id AND c.deleted_at IS NULL
    LEFT JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = p_user AND cm.left_at IS NULL
    WHERE m.id = p_message AND m.deleted_at IS NULL
      AND (m.expires_at IS NULL OR m.expires_at > now())
      AND EXISTS (SELECT 1 FROM conversation_permissions(c.id) p WHERE p.user_id = p_user
        AND ((p.permissions & 3) = 3 OR (p.permissions & 4611686018427387904) <> 0))
      AND m.seq > coalesce(cm.history_start_seq, 0)
      AND NOT EXISTS (SELECT 1 FROM message_deletions d WHERE d.message_id = m.id AND d.user_id = p_user)
  );
$fn$;

CREATE INDEX IF NOT EXISTS community_reminders_pending_idx ON community_reminders(due_at)
  WHERE delivered_at IS NULL AND cancelled_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS community_event_reminder_idx ON community_reminders(user_id, event_id)
  WHERE event_id IS NOT NULL AND delivered_at IS NULL AND cancelled_at IS NULL;
