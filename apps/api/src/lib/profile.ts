import { and, eq, isNull, media, users, usernameHistory } from '@yappy/db';
import { AppError, ErrorCode, LIMITS, newId, username as usernameSchema } from '@yappy/shared';
import type { FastifyInstance } from 'fastify';
import {
  affiliationAvatar,
  affiliationAvatarOn,
  affiliationColumns,
  affiliationGroup,
  affiliationGroupOn,
  affiliationMembership,
  affiliationMembershipOn,
  pickAffiliation,
} from './affiliation.js';
import { toPublicUser } from './serialize.js';

/**
 * Editing your own profile.
 *
 * One implementation, because there are two ways in — `PATCH /users/me` and
 * yapper's `/username`, `/name`, `/bio` — and the parts that matter are
 * exactly the parts a second implementation would forget. For the username
 * those are a rate limit and a history row: the limit is what stops a handle
 * being cycled, the history is what makes the cycling visible afterwards, and
 * either one missing on either path defeats both.
 *
 * A username is unlike the rest of a profile. A display name is a label, and
 * two people may share one; a username is *the* way someone is referred to and
 * only one account can hold it at a time. So it can be handed over, which
 * makes "take the handle someone just gave up, wear it for an evening,
 * abandon it" a move worth making — and free, until it isn't.
 */

/** Is this name well-formed, unreserved and unheld? */
export async function checkUsername(
  app: FastifyInstance,
  candidate: string,
): Promise<{ available: boolean; reason?: string; normalised?: string }> {
  const parsed = usernameSchema.safeParse(candidate);
  if (!parsed.success) {
    // The schema's own message — "no repeated separators", "that username is
    // reserved" — says more than "unavailable" ever could, and the difference
    // is between someone fixing their input and someone guessing at it.
    return { available: false, reason: parsed.error.issues[0]?.message ?? 'Not a valid username' };
  }

  const [taken] = await app.db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.username, parsed.data), isNull(users.deletedAt)))
    .limit(1);

  return taken
    ? { available: false, reason: 'Taken', normalised: parsed.data }
    : { available: true, normalised: parsed.data };
}

/**
 * Take a username, recording what was given up.
 *
 * Throws rather than returning a result: every caller wants the same
 * behaviour for the same failure, and an `AppError` already carries the status
 * and code the REST surface needs. yapper catches it and renders the message.
 *
 * The uniqueness race is settled by the database, not by `checkUsername` —
 * two people can pass the check a millisecond apart, and only the partial
 * unique index decides which of them gets the name. That is why the insert is
 * wrapped rather than guarded.
 */
export async function changeUsername(
  app: FastifyInstance,
  userId: string,
  candidate: string,
): Promise<{ from: string | null; to: string }> {
  const check = await checkUsername(app, candidate);
  if (!check.normalised) {
    throw new AppError(400, ErrorCode.BadRequest, check.reason ?? 'Not a valid username');
  }
  const next = check.normalised;

  const [current] = await app.db
    .select({ username: users.username })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!current) throw new AppError(404, ErrorCode.NotFound, 'No such account');

  // Setting the name you already hold is a no-op, not a change. Charging the
  // limiter for it would let someone burn their own allowance by pressing a
  // button twice.
  if (current.username && current.username.toLowerCase() === next.toLowerCase()) {
    return { from: current.username, to: next };
  }

  if (!check.available) {
    throw new AppError(409, ErrorCode.AlreadyExists, 'That username is taken');
  }

  // Consumed only once the change is known to be real and possible, so a
  // rejected attempt costs nothing. Throws 429 with `retryAfter`.
  await app.limiter.consume(`user:${userId}`, 'username.change');

  try {
    await app.db.transaction(async (tx) => {
      await tx.update(users).set({ username: next }).where(eq(users.id, userId));

      // Only when there was a name to give up. An account claiming its first
      // username has vacated nothing, and a history row saying so would be a
      // row that means "no previous name" — which is what the absence of a
      // row already means.
      if (current.username) {
        await tx.insert(usernameHistory).values({
          id: newId(),
          userId,
          username: current.username,
          replacedBy: next,
        });
      }
    });
  } catch (err) {
    // Lost the race between the check above and the write. The partial unique
    // index on `username where deleted_at is null` is what makes that safe.
    if ((err as { code?: string }).code === '23505') {
      throw new AppError(409, ErrorCode.AlreadyExists, 'That username is taken');
    }
    throw err;
  }

  await publishProfileUpdate(app, userId);
  return { from: current.username, to: next };
}

/** Up to `displayNameMax`, and never blank — an empty name renders as nothing. */
export async function setDisplayName(
  app: FastifyInstance,
  userId: string,
  value: string,
): Promise<string> {
  const trimmed = value.trim().slice(0, LIMITS.displayNameMax);
  if (!trimmed) throw new AppError(400, ErrorCode.BadRequest, 'A display name cannot be empty');
  await app.db.update(users).set({ displayName: trimmed }).where(eq(users.id, userId));
  await publishProfileUpdate(app, userId);
  return trimmed;
}

/** Empty clears it, which is a real choice rather than an error. */
export async function setBio(
  app: FastifyInstance,
  userId: string,
  value: string,
): Promise<string | null> {
  const trimmed = value.trim().slice(0, LIMITS.bioMax);
  const next = trimmed.length > 0 ? trimmed : null;
  await app.db.update(users).set({ bio: next }).where(eq(users.id, userId));
  // No event: the bio is not part of `PublicUser`, so there is nothing in the
  // realtime payload for it to change. It arrives with the next profile read.
  return next;
}

/**
 * Tell everyone who can see this person that their profile moved.
 *
 * A change made outside the app the person is looking at — which is every
 * change made through yapper — leaves their own client showing the old value
 * until something forces a refetch. The gateway resolves `toUser` to the
 * account's own topic plus every conversation it is in, so one publish reaches
 * both them and everyone who renders their name.
 *
 * Re-read rather than serialised from the update's `returning()`: the avatar
 * and the affiliation badge are joins, and a payload that silently drops them
 * looks to a client exactly like the person having cleared both.
 */
async function publishProfileUpdate(app: FastifyInstance, userId: string): Promise<void> {
  try {
    const [row] = await app.db
      .select({ user: users, avatarKey: media.objectKey, ...affiliationColumns })
      .from(users)
      .leftJoin(media, eq(media.id, users.avatarMediaId))
      .leftJoin(affiliationGroup, affiliationGroupOn(users.affiliationConversationId))
      .leftJoin(affiliationAvatar, affiliationAvatarOn())
      .leftJoin(affiliationMembership, affiliationMembershipOn(users.id))
      .where(eq(users.id, userId))
      .limit(1);
    if (!row) return;

    await app.events.toUser(
      userId,
      'user.update',
      toPublicUser(row.user, row.avatarKey, pickAffiliation(row)),
    );
  } catch (err) {
    // The write already happened and is what people actually asked for. A
    // failed announcement costs a refresh, not the change.
    app.log.warn({ err, userId }, 'could not publish profile update');
  }
}
