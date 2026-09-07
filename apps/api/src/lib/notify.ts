import { and, conversationMembers, eq, inArray, isNull, notifications } from '@yappy/db';
import { Event, newId } from '@yappy/shared';
import type { FastifyInstance } from 'fastify';

/**
 * The in-app notification centre, written to.
 *
 * The table and the two routes in front of it have existed since the first
 * migration, and exactly one thing wrote to them: a follow. Everything else
 * the app does *to* a person happened silently — a group verified, an
 * affiliate badge granted, a promotion to administrator — or arrived as a
 * push and then existed nowhere. A push is a delivery attempt; it is dropped
 * when notifications are off, when the token is stale, when the phone was in
 * a tunnel. The feed is the record, and it is the only surface a person can
 * come back to and ask "what happened while I was away".
 *
 * Every call here does two things and neither may fail the caller: the row,
 * and a gateway nudge so an open app lights its bell without polling. A
 * notification is never the point of the request that produced it — the badge
 * is granted, the member is affiliated — so a failure to *say so* must never
 * roll that back.
 */

export type NotifyKind =
  /** This group was verified. To its owner and administrators. */
  | 'group_verified'
  /** The verification request was declined. To whoever asked. */
  | 'group_verification_declined'
  /** A badged group made you one of its affiliates. */
  | 'affiliate_granted'
  /** …and took it back. Said plainly: the badge vanishing unexplained is worse. */
  | 'affiliate_revoked'
  /** Made an owner or an administrator of a place. */
  | 'role_granted'
  | 'account_suspended'
  | 'account_warning'
  | 'account_restored'
  | 'new_sign_in'
  | 'badge_granted'
  | 'badge_revoked'
  | 'group_removed'
  | 'group_banned'
  | 'group_unbanned'
  | 'report_reviewed'
  | 'bug_updated'
  | 'follow'
  | 'follow_back';

export type NotifyInput = {
  userId: string;
  kind: NotifyKind;
  /** The person who did it, when a person did. Rendered as the row's face. */
  actorId?: string | null;
  targetType?: 'user' | 'conversation' | 'message' | null;
  targetId?: string | null;
  /**
   * Whatever the row needs to draw itself without a second request — a group's
   * title and badge, a role name. The client renders from this, so it must be
   * self-contained: the group may be gone by the time the feed is read.
   */
  data?: Record<string, unknown>;
  /**
   * Collapses repeats. Two grants of the same badge to the same person are one
   * line in the feed, not two.
   */
  groupKey?: string | null;
};

export async function notifyUser(app: FastifyInstance, input: NotifyInput): Promise<void> {
  try {
    await app.db.insert(notifications).values({
      id: newId(),
      userId: input.userId,
      kind: input.kind,
      actorId: input.actorId ?? null,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      data: input.data ?? {},
      groupKey: input.groupKey ?? null,
    });
  } catch (err) {
    app.log.error({ err, kind: input.kind }, 'notification insert failed');
    return;
  }

  // After the row is safe. The socket is a courtesy — the feed is the truth,
  // and the next open reads it either way.
  try {
    await app.events.toUser(input.userId, Event.NotificationCreate, {
      kind: input.kind,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      data: input.data ?? {},
    });
  } catch (err) {
    app.log.error({ err, kind: input.kind }, 'notification event failed');
  }
}

/**
 * The people who speak for a place: its owner and its administrators.
 *
 * Used for the things that happen to a group rather than to a person — a
 * badge granted, a request declined. Everyone who could have made the request
 * hears the answer, not only whoever happened to tap send, because the person
 * who asked may have left by the time staff got to it.
 */
export async function notifyPlaceLeaders(
  app: FastifyInstance,
  conversationId: string,
  input: Omit<NotifyInput, 'userId'>,
): Promise<void> {
  let leaders: Array<{ userId: string }> = [];
  try {
    leaders = await app.db
      .select({ userId: conversationMembers.userId })
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          isNull(conversationMembers.leftAt),
          // Roles beyond these two are members with extra permissions, not
          // the group's voice.
          inArray(conversationMembers.role, ['owner', 'admin']),
        ),
      );
  } catch (err) {
    app.log.error({ err, conversationId }, 'notification leader lookup failed');
    return;
  }

  for (const leader of leaders) {
    await notifyUser(app, { ...input, userId: leader.userId });
  }
}
