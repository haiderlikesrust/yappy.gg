import { and, earlyClaims, eq, inArray, sql as raw, users } from '@yappy/db';
import { EARLY_CLAIM, newId } from '@yappy/shared';
import type { FastifyInstance } from 'fastify';
import { getSystemConversationId } from './staffspace.js';
import { getYapperUserId } from './yapper.js';

/**
 * The early-tester reward: who qualifies, who has a slot, and who gets told.
 *
 * The shape of this file is set by one constraint — the treasury is three
 * payments wide. Everything else follows from refusing to tell a fourth person
 * they have won something there is no money for.
 *
 * So a slot is taken at the moment somebody is *notified*, not when they ask to
 * be paid. That inverts the obvious design and it is the point: "you can claim
 * $20" is either true when it is sent or it should not be sent. An untouched
 * reservation expires back into the pool.
 */

/** Statuses that occupy a slot. `expired` and `cancelled` give it back. */
const HOLDS_SLOT = ['reserved', 'submitted', 'paid'] as const;

export type ClaimStatus = 'reserved' | 'submitted' | 'paid' | 'expired' | 'cancelled';

export interface ClaimProgress {
  /** Messages somebody else replied to or reacted to. */
  answered: number;
  answeredRequired: number;
  acceptedBugs: number;
  acceptedBugsRequired: number;
  /** Meets the bar. Says nothing about whether there is money left. */
  qualifies: boolean;
  slotsTotal: number;
  slotsLeft: number;
  amountUsd: number;
  /** Their own claim, if they have one. */
  claim: {
    status: ClaimStatus;
    walletAddress: string | null;
    expiresAt: string;
    txSignature: string | null;
    /** Typed on the web. Read by nobody yet. */
    submittedAt: string | null;
    /** Read back and confirmed in the app. This is what payment works from. */
    confirmedAt: string | null;
  } | null;
}

/**
 * Sweep reservations nobody acted on.
 *
 * Called at the top of every read rather than on a timer: the number of rows is
 * three, the query is indexed, and a lazy sweep means the count a page shows is
 * never stale in the one direction that matters — claiming to be full when a
 * slot has actually freed up.
 */
async function expireStaleReservations(app: FastifyInstance): Promise<void> {
  await app.db.execute(raw`
    update early_claims
       set status = 'expired', updated_at = now()
     where status = 'reserved'
       and expires_at < now()
  `);
}

async function slotsTaken(app: FastifyInstance): Promise<number> {
  const rows = await app.db
    .select({ id: earlyClaims.id })
    .from(earlyClaims)
    .where(inArray(earlyClaims.status, HOLDS_SLOT as unknown as string[]));
  return rows.length;
}

/**
 * How many messages of theirs somebody else answered.
 *
 * A reaction or a reply, from anyone but them. Kept identical to the query
 * behind `/eligible` so the number a person sees on the claim page is the same
 * number staff saw when the bar was chosen.
 */
async function answeredCount(app: FastifyInstance, userId: string): Promise<number> {
  const [row] = (await app.db.execute(raw`
    select count(*)::int as n
      from messages m
     where m.sender_id = ${userId}::uuid
       and m.deleted_at is null
       and (
         exists (
           select 1 from message_reactions r
            where r.message_id = m.id and r.user_id <> m.sender_id
         )
         or exists (
           select 1 from messages q
            where q.reply_to_id = m.id and q.deleted_at is null and q.sender_id <> m.sender_id
         )
       )
  `)) as unknown as Array<{ n: number }>;
  return Number(row?.n ?? 0);
}

async function acceptedBugCountFor(app: FastifyInstance, userId: string): Promise<number> {
  const [row] = (await app.db.execute(raw`
    select count(*)::int as n
      from bug_reports
     where reporter_id = ${userId}::uuid
       and status in ('fixed', 'known')
  `)) as unknown as Array<{ n: number }>;
  return Number(row?.n ?? 0);
}

export async function claimProgress(app: FastifyInstance, userId: string): Promise<ClaimProgress> {
  await expireStaleReservations(app);

  const [answered, acceptedBugs, taken, existing] = await Promise.all([
    answeredCount(app, userId),
    acceptedBugCountFor(app, userId),
    slotsTaken(app),
    app.db.select().from(earlyClaims).where(eq(earlyClaims.userId, userId)).limit(1),
  ]);

  const claim = existing[0];

  return {
    answered,
    answeredRequired: EARLY_CLAIM.answeredRequired,
    acceptedBugs,
    acceptedBugsRequired: EARLY_CLAIM.acceptedBugsRequired,
    qualifies:
      answered >= EARLY_CLAIM.answeredRequired ||
      acceptedBugs >= EARLY_CLAIM.acceptedBugsRequired,
    slotsTotal: EARLY_CLAIM.slots,
    slotsLeft: Math.max(0, EARLY_CLAIM.slots - taken),
    amountUsd: EARLY_CLAIM.amountUsd,
    claim: claim
      ? {
          status: claim.status as ClaimStatus,
          walletAddress: claim.walletAddress,
          expiresAt: claim.expiresAt.toISOString(),
          txSignature: claim.txSignature,
          submittedAt: claim.submittedAt?.toISOString() ?? null,
          confirmedAt: claim.confirmedAt?.toISOString() ?? null,
        }
      : null,
  };
}

/**
 * Take a slot for somebody who qualifies, if there is one.
 *
 * Returns null when they do not qualify, already have a claim, or the treasury
 * is spent. The unique index on `user_id` is what actually holds the line — two
 * notifications racing for the last slot both insert, one loses, and the loser
 * is told nothing.
 */
export async function reserveSlot(
  app: FastifyInstance,
  userId: string,
): Promise<{ expiresAt: Date } | null> {
  if (!EARLY_CLAIM.open) return null;

  const progress = await claimProgress(app, userId);
  if (!progress.qualifies || progress.claim || progress.slotsLeft <= 0) return null;

  const expiresAt = new Date(Date.now() + EARLY_CLAIM.reservationHours * 3_600_000);

  try {
    await app.db.insert(earlyClaims).values({
      id: newId(),
      userId,
      status: 'reserved',
      amountUsd: EARLY_CLAIM.amountUsd,
      expiresAt,
    });
  } catch {
    // Lost the race on the unique index. Somebody else has the slot, or this
    // person already had a claim — either way there is nothing to announce.
    return null;
  }

  // Re-check *after* inserting rather than before. Two processes can both read
  // "one slot left" and both insert; the count afterwards is the only honest
  // one, and the loser gives its row back rather than overspending.
  const taken = await slotsTaken(app);
  if (taken > EARLY_CLAIM.slots) {
    await app.db
      .update(earlyClaims)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(and(eq(earlyClaims.userId, userId), eq(earlyClaims.status, 'reserved')));
    return null;
  }

  return { expiresAt };
}

/**
 * A Solana address, or a reason it is not one.
 *
 * Base58, decoding to exactly 32 bytes. This catches a wrong alphabet, a
 * truncation, a pasted Ethereum address — the shape being wrong.
 *
 * It cannot catch a typo, and no function can. A Solana address is a raw
 * ed25519 public key with **no checksum**: any 32 bytes is a syntactically
 * valid address, so one character wrong is simply a different valid address
 * belonging to nobody, and USDC sent there is gone with no one to ask.
 *
 * Two consequences worth stating, because both look like bugs otherwise.
 *
 * Length is not fixed at 44. Leading zero bytes shorten the base58 encoding,
 * so real addresses run 32–44 characters — and a 43-character string genuinely
 * can be 32 bytes. Dropping the last character of a valid address sometimes
 * still validates. That is correct behaviour, not a hole to plug.
 *
 * Which means the confirmation step is not a courtesy. Echoing the address
 * back in the app, in full and untruncated, is the *only* thing standing
 * between a slipped keystroke and lost money.
 */
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function validateSolanaAddress(input: string): { ok: true } | { ok: false; reason: string } {
  const address = input.trim();
  if (address.length < 32 || address.length > 44) {
    return { ok: false, reason: 'A Solana address is 32 to 44 characters.' };
  }

  for (const ch of address) {
    if (!BASE58.includes(ch)) {
      return {
        ok: false,
        reason: `"${ch}" cannot appear in a Solana address — 0, O, I and l are never used.`,
      };
    }
  }

  // Decode to bytes. Base58 has no fixed characters-to-bytes ratio, so length
  // alone does not establish this.
  let value = 0n;
  for (const ch of address) value = value * 58n + BigInt(BASE58.indexOf(ch));

  let bytes = 0;
  for (let v = value; v > 0n; v >>= 8n) bytes++;
  // Leading '1's are leading zero bytes and carry no magnitude.
  for (const ch of address) {
    if (ch !== '1') break;
    bytes++;
  }

  if (bytes !== 32) {
    return { ok: false, reason: 'That is the right shape but not a valid address — check it again.' };
  }

  return { ok: true };
}

/**
 * Record an address somebody typed on the web.
 *
 * Leaves the claim `reserved`, and clears any previous confirmation. Typing is
 * not confirming: nothing should be paid on the strength of a string that has
 * been read by no human. A second address supersedes the first and has to be
 * confirmed again on its own merits.
 */
export async function submitAddress(
  app: FastifyInstance,
  userId: string,
  walletAddress: string,
): Promise<boolean> {
  const updated = await app.db
    .update(earlyClaims)
    .set({
      walletAddress: walletAddress.trim(),
      status: 'reserved',
      submittedAt: new Date(),
      confirmedAt: null,
      updatedAt: new Date(),
    })
    .where(and(eq(earlyClaims.userId, userId), inArray(earlyClaims.status, ['reserved', 'submitted'])))
    .returning({ id: earlyClaims.id });

  return updated.length > 0;
}

/**
 * They read the address back and said yes.
 *
 * Recorded as its own step rather than folded into `submitAddress`, so a claim
 * that was typed but never confirmed is distinguishable from one that was.
 * Whoever sends the money should only ever be working from confirmed rows.
 */
export async function confirmClaimAddress(app: FastifyInstance, userId: string): Promise<boolean> {
  const updated = await app.db
    .update(earlyClaims)
    .set({ status: 'submitted', confirmedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(earlyClaims.userId, userId),
        inArray(earlyClaims.status, ['reserved', 'submitted']),
        raw`wallet_address is not null`,
      ),
    )
    .returning({ id: earlyClaims.id });

  if (updated.length === 0) return false;

  // Tell staff there is somebody to pay. Without this the whole flow ends in a
  // row in a table that nobody is watching, and the person waits for a payment
  // no one knows to send.
  await postClaimCard(app, userId).catch((err) => {
    app.log.error({ err, userId }, 'claim card failed to post');
  });

  return true;
}

/**
 * "Somebody is owed $20, here is where it goes."
 *
 * Posted into the staff space on confirmation, with the address whole and a
 * button to record the transaction once it has been sent. Payment is by hand —
 * this is the hand's worklist.
 */
export async function postClaimCard(app: FastifyInstance, userId: string): Promise<void> {
  const channelId = await getSystemConversationId(app, 'staff_general');
  const botId = await getYapperUserId(app);
  if (!channelId || !botId) return;

  const [row] = await app.db
    .select({ claim: earlyClaims, name: users.displayName, handle: users.username })
    .from(earlyClaims)
    .leftJoin(users, eq(users.id, earlyClaims.userId))
    .where(eq(earlyClaims.userId, userId))
    .limit(1);
  if (!row?.claim.walletAddress) return;

  const who = row.name ?? row.handle ?? 'Someone';

  await app.messages.send(botId, channelId, {
    // Keyed on the address, so re-confirming a *corrected* address posts a new
    // card rather than silently reusing the one with the old one on it.
    nonce: `claim_${userId.slice(0, 8)}_${row.claim.walletAddress.slice(0, 12)}`,
    type: 'text',
    content: null,
    embeds: [
      {
        title: `Pay ${who} $${row.claim.amountUsd} ${EARLY_CLAIM.currency}`,
        description: 'Confirmed in the app by the person it belongs to. Send it, then record it here.',
        color: '#3dd68c',
        fields: [
          { name: 'Address', value: row.claim.walletAddress, inline: false },
          { name: 'Chain', value: EARLY_CLAIM.chain, inline: true },
          { name: 'Confirmed', value: (row.claim.confirmedAt ?? new Date()).toUTCString(), inline: true },
        ],
        footer: { text: 'Check the address against theirs before sending. It cannot be undone.' },
      },
    ],
    components: [
      {
        type: 'row',
        components: [
          {
            type: 'button',
            customId: `claimpaid:${userId}`,
            label: 'I have sent it',
            style: 'success',
            disabled: false,
            staffOnly: true,
          },
        ],
      },
    ],
    silent: false,
  } as never);
}

/** Record that the money went out, and tell them. */
export async function markClaimPaid(
  app: FastifyInstance,
  userId: string,
  txSignature: string | null,
): Promise<boolean> {
  const updated = await app.db
    .update(earlyClaims)
    .set({ status: 'paid', paidAt: new Date(), txSignature, updatedAt: new Date() })
    .where(and(eq(earlyClaims.userId, userId), eq(earlyClaims.status, 'submitted')))
    .returning({ amountUsd: earlyClaims.amountUsd });

  if (updated.length === 0) return false;

  await app.enqueue('yapper.dm', {
    userId,
    kind: 'claim_paid',
    dedupe: `claim_paid:${userId}`,
    payload: { amountUsd: updated[0]!.amountUsd, txSignature },
  });

  return true;
}

/**
 * Everyone who qualifies and has not been told.
 *
 * Ordered oldest-account-first so that, when there are fewer slots than
 * qualifiers, the tie breaks on who was here first rather than on whichever row
 * the planner happened to return.
 */
export async function pendingNotifications(
  app: FastifyInstance,
  limit: number,
): Promise<Array<{ userId: string }>> {
  if (!EARLY_CLAIM.open) return [];

  const rows = (await app.db.execute(raw`
    select u.id as user_id
      from users u
      left join early_claims c on c.user_id = u.id
     where u.is_bot = false
       and u.deleted_at is null
       and c.id is null
       and (
         (select count(*) from bug_reports b
           where b.reporter_id = u.id and b.status in ('fixed','known'))
             >= ${EARLY_CLAIM.acceptedBugsRequired}
         or
         (select count(*) from messages m
           where m.sender_id = u.id and m.deleted_at is null
             and (
               exists (select 1 from message_reactions r
                        where r.message_id = m.id and r.user_id <> m.sender_id)
               or exists (select 1 from messages q
                           where q.reply_to_id = m.id and q.deleted_at is null
                             and q.sender_id <> m.sender_id)
             ))
             >= ${EARLY_CLAIM.answeredRequired}
       )
     order by u.created_at
     limit ${limit}
  `)) as unknown as Array<{ user_id: string }>;

  return rows.map((r) => ({ userId: r.user_id }));
}
