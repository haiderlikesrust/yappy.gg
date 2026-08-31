-- Constraints and generated columns that Drizzle's schema DSL cannot express.
-- Every statement here is idempotent; migrate.ts re-runs the whole file.

-- ─── Integrity rules the application must never be able to violate ──────────

DO $$ BEGIN
  ALTER TABLE follows ADD CONSTRAINT follows_no_self CHECK (follower_id <> followee_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE blocks ADD CONSTRAINT blocks_no_self CHECK (blocker_id <> blocked_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE messages ADD CONSTRAINT messages_seq_positive CHECK (seq > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A DM must carry a dm_key and a group must not: the partial unique index on
-- dm_key is the only thing preventing duplicate DM threads, and it is useless
-- if the column can be left null.
DO $$ BEGIN
  ALTER TABLE conversations ADD CONSTRAINT conversations_dm_key_required
    CHECK ((type = 'dm') = (dm_key IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Spaces contain channels and nothing else contains anything. Written as a
-- constraint rather than left to the application because the whole permission
-- model assumes exactly one level: `loadMemberContext` reads a channel's
-- authority from its parent and stops there, so a channel whose parent is
-- itself a channel would silently lose its inherited roles.
DO $$ BEGIN
  ALTER TABLE conversations ADD CONSTRAINT conversations_parent_fk
    FOREIGN KEY (parent_id) REFERENCES conversations(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE conversations ADD CONSTRAINT conversations_only_channels_nest
    CHECK (parent_id IS NULL OR type = 'channel');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One level, enforced. A row that is somebody's parent must be a space, and a
-- space may not itself have one.
CREATE OR REPLACE FUNCTION assert_parent_is_space() RETURNS trigger AS $$
BEGIN
  IF NEW.parent_id IS NOT NULL THEN
    IF NEW.parent_id = NEW.id THEN
      RAISE EXCEPTION 'a conversation cannot be its own parent';
    END IF;
    IF (SELECT type FROM conversations WHERE id = NEW.parent_id) <> 'space' THEN
      RAISE EXCEPTION 'a channel''s parent must be a space';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS conversations_parent_is_space ON conversations;
CREATE TRIGGER conversations_parent_is_space
  BEFORE INSERT OR UPDATE OF parent_id ON conversations
  FOR EACH ROW EXECUTE FUNCTION assert_parent_is_space();

DO $$ BEGIN
  ALTER TABLE conversation_members ADD CONSTRAINT members_read_seq_sane
    CHECK (last_read_seq >= 0 AND last_delivered_seq >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── Full-text search ───────────────────────────────────────────────────────
-- 'simple' rather than 'english': the user base is multilingual and stemming
-- English rules over Urdu or Turkish text produces worse results than none.
-- Trigram indexes on users cover fuzzy name matching separately.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', coalesce(content, ''))) STORED;

CREATE INDEX IF NOT EXISTS messages_search_idx
  ON messages USING gin (search_vector);

-- Search is always scoped to conversations the caller is in, so the composite
-- (conversation, vector) index is what actually gets used.
CREATE INDEX IF NOT EXISTS messages_search_scoped_idx
  ON messages USING gin (conversation_id, search_vector)
  WHERE deleted_at IS NULL;

-- ─── Hot-path covering indexes ──────────────────────────────────────────────

-- History fetch: newest-first page of live messages in one conversation.
CREATE INDEX IF NOT EXISTS messages_history_idx
  ON messages (conversation_id, seq DESC)
  WHERE deleted_at IS NULL;

-- Unread badge across every conversation, in one index-only scan.
CREATE INDEX IF NOT EXISTS members_badge_idx
  ON conversation_members (user_id, conversation_id, last_read_seq, mention_count)
  WHERE left_at IS NULL AND is_archived = false;

-- The disappearing-message sweeper's index used to be declared here as
-- messages_expiry_sweep_idx, and is now declared in the schema itself as
-- messages_expires_idx — byte-for-byte the same index under a second name.
--
-- Both existed, so every message insert maintained the identical B-tree twice.
-- Dropping it changes no query plan: the definitions match exactly, so the
-- planner simply uses the survivor.
DROP INDEX IF EXISTS messages_expiry_sweep_idx;

-- A channel's category is a label, and losing the label must never lose the
-- room. Declared here rather than in the Drizzle schema because conversations
-- and channel_categories would then reference each other's types and
-- TypeScript gives up on inferring either.
DO $$ BEGIN
  ALTER TABLE conversations ADD CONSTRAINT conversations_category_fk
    FOREIGN KEY (category_id) REFERENCES channel_categories(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
