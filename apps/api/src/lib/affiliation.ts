import { alias, and, conversationMembers, conversations, eq, isNull, media, users } from '@yappy/db';
import type { AffiliationRow } from './serialize.js';

/**
 * The affiliation join, in one place.
 *
 * Every surface that renders a name — message senders, member lists, profiles —
 * wants the affiliated group's logo beside it, and each of those queries
 * already loads the user's own avatar from `media`. So this comes in as three
 * aliased left joins rather than a second round trip: joins on primary keys are
 * far cheaper than an N+1, and it keeps "does this query remember
 * affiliations?" answerable by grep.
 *
 * The membership join is the part that is easy to talk yourself out of. Without
 * it, a group that revokes someone's affiliate status keeps conferring its logo
 * until some write path remembers to clear the user's column — and there are
 * several ways to stop being a member (leave, kick, ban, group deleted), so one
 * of them would eventually be missed. Verifying at read time means revocation
 * is immediate and cannot be forgotten. Affiliation is a credibility signal;
 * a stale one is worse than none.
 *
 * Aliases are mandatory: `media` is already joined for the user's own avatar,
 * and Postgres will not tolerate the same relation twice under one name.
 */

export const affiliationGroup = alias(conversations, 'affiliation_group');
export const affiliationAvatar = alias(media, 'affiliation_avatar');
export const affiliationMembership = alias(conversationMembers, 'affiliation_membership');

/** Spread into a `.select({ ... })` alongside the query's own columns. */
export const affiliationColumns = {
  affiliationId: affiliationGroup.id,
  affiliationTitle: affiliationGroup.title,
  affiliationBadge: affiliationGroup.badge,
  affiliationAvatarKey: affiliationAvatar.objectKey,
  affiliationConfirmed: affiliationMembership.isAffiliate,
} as const;

/**
 * Join predicates, so a call site reads:
 *
 *   .leftJoin(affiliationGroup, affiliationGroupOn(users.affiliationConversationId))
 *   .leftJoin(affiliationAvatar, affiliationAvatarOn())
 *   .leftJoin(affiliationMembership, affiliationMembershipOn(users.id))
 */
export const affiliationGroupOn = (userAffiliationCol: typeof users.affiliationConversationId) =>
  and(eq(affiliationGroup.id, userAffiliationCol), isNull(affiliationGroup.deletedAt));

export const affiliationAvatarOn = () => eq(affiliationAvatar.id, affiliationGroup.avatarMediaId);

export const affiliationMembershipOn = (userIdCol: typeof users.id) =>
  and(
    eq(affiliationMembership.conversationId, affiliationGroup.id),
    eq(affiliationMembership.userId, userIdCol),
    isNull(affiliationMembership.leftAt),
  );

export type AffiliationColumns = {
  affiliationId: string | null;
  affiliationTitle: string | null;
  affiliationBadge: string | null;
  affiliationAvatarKey: string | null;
  affiliationConfirmed: boolean | null;
};

/** Collapse the flat columns back into the shape `toPublicUser` wants. */
export const pickAffiliation = (row: Partial<AffiliationColumns>): AffiliationRow | null =>
  row.affiliationId && row.affiliationConfirmed
    ? {
        id: row.affiliationId,
        title: row.affiliationTitle ?? null,
        badge: row.affiliationBadge ?? null,
        avatarKey: row.affiliationAvatarKey ?? null,
      }
    : null;
