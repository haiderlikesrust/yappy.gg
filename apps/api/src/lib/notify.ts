import {
  and,
  conversationMembers,
  eq,
  inArray,
  isNull,
  notifications,
  pushOutbox,
  users,
} from "@yappy/db";
import { Event, newId } from "@yappy/shared";
import type { FastifyInstance } from "fastify";

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
 * Each call saves the row and nudges the gateway so an open app lights its
 * bell. Supported centre kinds also queue a push in the row's transaction. A
 * notification is never the point of the request that produced it — the badge
 * is granted, the member is affiliated — so a failure to *say so* must never
 * roll that back.
 */

export type NotifyKind =
  /** This group was verified. To its owner and administrators. */
  | "group_verified"
  /** The verification request was declined. To whoever asked. */
  | "group_verification_declined"
  /** A badged group made you one of its affiliates. */
  | "affiliate_granted"
  /** …and took it back. Said plainly: the badge vanishing unexplained is worse. */
  | "affiliate_revoked"
  /** Made an owner or an administrator of a place. */
  | "role_granted"
  | "account_suspended"
  | "account_warning"
  | "account_restored"
  | "new_sign_in"
  | "badge_granted"
  | "badge_revoked"
  | "group_removed"
  | "group_banned"
  | "group_unbanned"
  | "report_reviewed"
  | "bug_updated"
  | "follow"
  | "follow_back";

export type NotifyInput = {
  userId: string;
  kind: NotifyKind;
  /** The person who did it, when a person did. Rendered as the row's face. */
  actorId?: string | null;
  targetType?: "user" | "conversation" | "message" | null;
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

export async function notifyUser(
  app: FastifyInstance,
  input: NotifyInput,
): Promise<void> {
  try {
    const notificationId = newId();
    await app.db.transaction(async (tx) => {
      await tx.insert(notifications).values({
        id: notificationId,
        userId: input.userId,
        kind: input.kind,
        actorId: input.actorId ?? null,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        data: input.data ?? {},
        groupKey: input.groupKey ?? null,
      });
      const copy = notificationPushCopy(input);
      if (copy) {
        const [recipient] = await tx
          .select({ settings: users.notifications })
          .from(users)
          .where(and(eq(users.id, input.userId), isNull(users.deletedAt)))
          .limit(1);
        if (recipient)
          await tx.insert(pushOutbox).values({
            id: newId(),
            userId: input.userId,
            kind: "system",
            dedupeKey: `notice:${notificationId}`,
            collapseKey: `notice:${notificationId}`,
            title:
              recipient.settings.showPreview === false ? "yappy" : copy.title,
            body:
              recipient.settings.showPreview === false
                ? "You have a new notification"
                : copy.body,
            sound: recipient.settings.sound ?? "default",
            data: {
              type: "notification",
              notificationId,
              kind: input.kind,
              targetType: input.targetType ?? "",
              targetId: input.targetId ?? "",
              ...(input.targetType === "conversation"
                ? { conversationId: input.targetId }
                : {}),
            },
            expiresAt: new Date(Date.now() + 86_400_000),
          });
      }
    });
  } catch (err) {
    app.log.error({ err, kind: input.kind }, "notification insert failed");
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
    app.log.error({ err, kind: input.kind }, "notification event failed");
  }
}

/** Release 2.6's notification-centre notices also need a delivery attempt. */
function notificationPushCopy(
  input: NotifyInput,
): { title: string; body: string } | null {
  const title =
    typeof input.data?.title === "string" ? input.data.title : "Your group";
  switch (input.kind) {
    case "group_verified":
      return { title, body: "Your group is now verified" };
    case "group_verification_declined":
      return { title, body: "Your group verification was declined or removed" };
    case "affiliate_granted":
      return { title, body: "You are now an affiliate of this group" };
    case "role_granted":
      return { title, body: "You have been given a new role in this group" };
    default:
      return null;
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
  input: Omit<NotifyInput, "userId">,
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
          inArray(conversationMembers.role, ["owner", "admin"]),
        ),
      );
  } catch (err) {
    app.log.error({ err, conversationId }, "notification leader lookup failed");
    return;
  }

  for (const leader of leaders) {
    await notifyUser(app, { ...input, userId: leader.userId });
  }
}
