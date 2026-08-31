import { sql as raw, type Database } from '@yappy/db';
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
