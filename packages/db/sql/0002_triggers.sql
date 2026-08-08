-- Denormalisation maintained in the database rather than the application.
--
-- The rule used here: a counter goes in a trigger when *every* writer must
-- maintain it and a missed update is silently wrong (reaction counts, member
-- counts, mutual-follow flags). Anything requiring business context — deciding
-- who gets a push, what a system message says — stays in application code
-- where it is testable.

-- ─── updated_at ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users','conversations','messages','media','sticker_packs','calls',
    'call_participants','reports','scheduled_messages'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_touch ON %I', t, t);
    EXECUTE format(
      'CREATE TRIGGER %I_touch BEFORE UPDATE ON %I
       FOR EACH ROW EXECUTE FUNCTION touch_updated_at()', t, t);
  END LOOP;
END $$;

-- ─── Reaction rollup ────────────────────────────────────────────────────────
-- messages.reaction_counts is what the history endpoint returns. Recomputing
-- it per page from message_reactions would mean an aggregate per message.

CREATE OR REPLACE FUNCTION sync_reaction_counts() RETURNS trigger AS $$
DECLARE
  target_id uuid := COALESCE(NEW.message_id, OLD.message_id);
  delta int := CASE TG_OP WHEN 'INSERT' THEN 1 ELSE -1 END;
  key text := COALESCE(NEW.emoji, OLD.emoji);
  current int;
BEGIN
  SELECT COALESCE((reaction_counts ->> key)::int, 0) INTO current
    FROM messages WHERE id = target_id;

  IF current + delta <= 0 THEN
    UPDATE messages SET reaction_counts = reaction_counts - key WHERE id = target_id;
  ELSE
    UPDATE messages
       SET reaction_counts = jsonb_set(reaction_counts, ARRAY[key], to_jsonb(current + delta))
     WHERE id = target_id;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS reactions_rollup ON message_reactions;
CREATE TRIGGER reactions_rollup
  AFTER INSERT OR DELETE ON message_reactions
  FOR EACH ROW EXECUTE FUNCTION sync_reaction_counts();

-- ─── Mutual follows ─────────────────────────────────────────────────────────
-- "Are we friends" is checked on every privacy decision. Maintaining the flag
-- on both rows turns it into a single indexed boolean read.

CREATE OR REPLACE FUNCTION sync_follow_mutual() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE follows SET is_mutual = true
      WHERE follower_id = NEW.followee_id AND followee_id = NEW.follower_id;
    IF FOUND THEN
      UPDATE follows SET is_mutual = true
        WHERE follower_id = NEW.follower_id AND followee_id = NEW.followee_id;
    END IF;
  ELSE
    UPDATE follows SET is_mutual = false
      WHERE follower_id = OLD.followee_id AND followee_id = OLD.follower_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS follows_mutual ON follows;
CREATE TRIGGER follows_mutual
  AFTER INSERT OR DELETE ON follows
  FOR EACH ROW EXECUTE FUNCTION sync_follow_mutual();

-- ─── Member count ───────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION sync_member_count() RETURNS trigger AS $$
DECLARE cid uuid := COALESCE(NEW.conversation_id, OLD.conversation_id);
BEGIN
  UPDATE conversations c
     SET member_count = (
       SELECT count(*) FROM conversation_members m
        WHERE m.conversation_id = cid AND m.left_at IS NULL
     )
   WHERE c.id = cid;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS members_count ON conversation_members;
CREATE TRIGGER members_count
  AFTER INSERT OR DELETE OR UPDATE OF left_at ON conversation_members
  FOR EACH ROW EXECUTE FUNCTION sync_member_count();

-- ─── Mention counters ───────────────────────────────────────────────────────
-- Incremented when a mention row appears; recomputed (not decremented) when a
-- read cursor moves, because a cursor can jump backwards.

CREATE OR REPLACE FUNCTION bump_mention_count() RETURNS trigger AS $$
BEGIN
  UPDATE conversation_members
     SET mention_count = mention_count + 1
   WHERE conversation_id = NEW.conversation_id
     AND user_id = NEW.user_id
     AND left_at IS NULL
     AND NEW.seq > last_read_seq;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS mentions_bump ON message_mentions;
CREATE TRIGGER mentions_bump
  AFTER INSERT ON message_mentions
  FOR EACH ROW EXECUTE FUNCTION bump_mention_count();

CREATE OR REPLACE FUNCTION recount_mentions_on_read() RETURNS trigger AS $$
BEGIN
  IF NEW.last_read_seq IS DISTINCT FROM OLD.last_read_seq THEN
    NEW.mention_count := (
      SELECT count(*) FROM message_mentions m
       WHERE m.user_id = NEW.user_id
         AND m.conversation_id = NEW.conversation_id
         AND m.seq > NEW.last_read_seq
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS members_recount_mentions ON conversation_members;
CREATE TRIGGER members_recount_mentions
  BEFORE UPDATE OF last_read_seq ON conversation_members
  FOR EACH ROW EXECUTE FUNCTION recount_mentions_on_read();

-- ─── Thread reply count ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION sync_thread_count() RETURNS trigger AS $$
BEGIN
  IF NEW.thread_root_id IS NOT NULL AND NEW.thread_root_id <> NEW.id THEN
    UPDATE messages SET thread_reply_count = thread_reply_count + 1
     WHERE id = NEW.thread_root_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS messages_thread_count ON messages;
CREATE TRIGGER messages_thread_count
  AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION sync_thread_count();

-- ─── Poll tallies ───────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION sync_poll_counts() RETURNS trigger AS $$
DECLARE
  oid uuid := COALESCE(NEW.option_id, OLD.option_id);
  pid uuid := COALESCE(NEW.poll_id, OLD.poll_id);
BEGIN
  UPDATE poll_options SET vote_count = (
    SELECT count(*) FROM poll_votes v WHERE v.option_id = oid
  ) WHERE id = oid;

  UPDATE polls SET total_voters = (
    SELECT count(DISTINCT user_id) FROM poll_votes v WHERE v.poll_id = pid
  ) WHERE id = pid;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS poll_votes_count ON poll_votes;
CREATE TRIGGER poll_votes_count
  AFTER INSERT OR DELETE ON poll_votes
  FOR EACH ROW EXECUTE FUNCTION sync_poll_counts();

-- ─── Media reference counting ───────────────────────────────────────────────
-- Media is only safe to garbage-collect at zero references. Doing this in the
-- application would leak storage every time a request failed halfway.

CREATE OR REPLACE FUNCTION sync_media_refcount() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE media SET ref_count = ref_count + 1 WHERE id = NEW.media_id;
  ELSE
    UPDATE media SET ref_count = GREATEST(ref_count - 1, 0) WHERE id = OLD.media_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS attachments_refcount ON message_attachments;
CREATE TRIGGER attachments_refcount
  AFTER INSERT OR DELETE ON message_attachments
  FOR EACH ROW EXECUTE FUNCTION sync_media_refcount();

-- ─── Sticker pack counters ──────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION sync_sticker_counts() RETURNS trigger AS $$
DECLARE pid uuid := COALESCE(NEW.pack_id, OLD.pack_id);
BEGIN
  UPDATE sticker_packs SET sticker_count = (
    SELECT count(*) FROM stickers s WHERE s.pack_id = pid AND s.deleted_at IS NULL
  ) WHERE id = pid;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS stickers_count ON stickers;
CREATE TRIGGER stickers_count
  AFTER INSERT OR DELETE OR UPDATE OF deleted_at ON stickers
  FOR EACH ROW EXECUTE FUNCTION sync_sticker_counts();

CREATE OR REPLACE FUNCTION sync_pack_installs() RETURNS trigger AS $$
DECLARE pid uuid := COALESCE(NEW.pack_id, OLD.pack_id);
BEGIN
  UPDATE sticker_packs SET install_count = (
    SELECT count(*) FROM user_sticker_packs u WHERE u.pack_id = pid
  ) WHERE id = pid;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pack_installs ON user_sticker_packs;
CREATE TRIGGER pack_installs
  AFTER INSERT OR DELETE ON user_sticker_packs
  FOR EACH ROW EXECUTE FUNCTION sync_pack_installs();

-- ─── Blocking cascade ───────────────────────────────────────────────────────
-- Blocking someone must also sever the follow in both directions, or their
-- posts keep appearing in your feed and yours in theirs.

CREATE OR REPLACE FUNCTION block_severs_follows() RETURNS trigger AS $$
BEGIN
  DELETE FROM follows
   WHERE (follower_id = NEW.blocker_id AND followee_id = NEW.blocked_id)
      OR (follower_id = NEW.blocked_id AND followee_id = NEW.blocker_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS blocks_sever ON blocks;
CREATE TRIGGER blocks_sever
  AFTER INSERT ON blocks
  FOR EACH ROW EXECUTE FUNCTION block_severs_follows();
