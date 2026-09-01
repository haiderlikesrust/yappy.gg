import { sql as raw, uuidArray, type Database } from '@yappy/db';
import { Event } from '@yappy/shared';
import type { EventPublisher } from './events.js';

/**
 * Telling somebody the badge above a channel moved.
 *
 * A space reports its channels' mentions along with its own, because a channel
 * never appears in the home list — a mention inside one would otherwise reach
 * nothing that draws a badge. The corollary is the part that kept breaking:
 * every event about a mention names the *channel*, and every client patches
 * its list by conversation id, so no row matches and the number on screen
 * never moves. It changed only on a full refetch, which is why the badge
 * seemed to stick at a stale count in both directions — it did not clear when
 * you read a channel, and it did not rise when a new mention arrived in one.
 *
 * So both paths say it explicitly, through here.
 *
 * Recomputed rather than adjusted by one. The counts it sums are maintained by
 * triggers — `mentions_bump` on the way in, `recount_mentions_on_read` on the
 * way out — and a number this code incremented in parallel would be a second
 * opinion about the same fact, drifting the first time the two disagreed.
 */
export async function announceMentionRollup(
  db: Database,
  events: EventPublisher,
  userId: string,
  spaceId: string,
): Promise<void> {
  const [rolled] = (await db.execute(
    raw`select coalesce(sum(cm.mention_count), 0)::int as mentions
          from conversation_members cm
          join conversations c on c.id = cm.conversation_id
         where cm.user_id = ${userId}::uuid
           and cm.left_at is null
           and c.deleted_at is null
           and (c.id = ${spaceId}::uuid or c.parent_id = ${spaceId}::uuid)`,
  )) as unknown as Array<{ mentions: number }>;

  await events.toUser(userId, Event.ConversationStateUpdate, {
    conversationId: spaceId,
    mentionCount: rolled?.mentions ?? 0,
  });
}

/**
 * The same announcement for several people at once.
 *
 * The send path calls this after a message that mentions N users. It used to
 * loop the singular version — one SUM plus one pg_notify per user, in series,
 * all billed to the sender's request. One grouped aggregate answers every
 * user, and the notifies go out together.
 *
 * Users the GROUP BY omits still get an event with a zero: the singular
 * version publishes `rolled?.mentions ?? 0` for an empty sum, and a client
 * that was told nothing keeps showing whatever stale badge it had.
 */
export async function announceMentionRollups(
  db: Database,
  events: EventPublisher,
  userIds: string[],
  spaceId: string,
): Promise<void> {
  if (userIds.length === 0) return;

  const rows = (await db.execute(
    raw`select cm.user_id, coalesce(sum(cm.mention_count), 0)::int as mentions
          from conversation_members cm
          join conversations c on c.id = cm.conversation_id
         where cm.user_id = any(${uuidArray(userIds)})
           and cm.left_at is null
           and c.deleted_at is null
           and (c.id = ${spaceId}::uuid or c.parent_id = ${spaceId}::uuid)
         group by cm.user_id`,
  )) as unknown as Array<{ user_id: string; mentions: number }>;

  const byUser = new Map(rows.map((r) => [r.user_id, r.mentions]));
  await Promise.all(
    userIds.map((userId) =>
      events.toUser(userId, Event.ConversationStateUpdate, {
        conversationId: spaceId,
        mentionCount: byUser.get(userId) ?? 0,
      }),
    ),
  );
}
