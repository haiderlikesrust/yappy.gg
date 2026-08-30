import { randomInt } from 'node:crypto';
import { and, eq, isNull, otpChallenges, sql as raw, type Database } from '@yappy/db';
import { newId } from '@yappy/shared';
import { hashToken } from './tokens.js';

/**
 * Six digits, hashed, single-use.
 *
 * `otp_challenges` has been in the schema since the beginning and unused since
 * the SMS plan was dropped — it is exactly the right table: an identifier, a
 * purpose, a *hashed* code, an attempt counter, an expiry and a consumed-at.
 * A database leak must not hand anybody live codes, which is why only the hash
 * is stored, the same way refresh tokens are.
 *
 * Why a code and not a link. yappy is a phone app, a web app and a desktop app,
 * and a link has to land somewhere that can finish the job on the device the
 * person is holding. Six digits work identically everywhere with no deep-link
 * plumbing, and they are what somebody typing on a phone next to an open inbox
 * actually wants.
 */

export type CodePurpose = 'email.verify' | 'password.reset';

export const CODE_TTL_MINUTES = 15;
const MAX_ATTEMPTS = 5;

/** Uniform over 000000–999999. `randomInt`, not `Math.random`. */
function sixDigits(): string {
  return String(randomInt(1_000_000)).padStart(6, '0');
}

/**
 * Issue a code for an address, invalidating any earlier one for the same
 * purpose — two live codes in one inbox is a support conversation, and it also
 * means an attacker who triggers a resend cannot keep a hoard of valid ones.
 */
export async function issueCode(
  db: Database,
  identifier: string,
  purpose: CodePurpose,
  requestIp: string | null,
): Promise<string> {
  const code = sixDigits();

  await db.transaction(async (tx) => {
    await tx
      .update(otpChallenges)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(otpChallenges.identifier, identifier),
          eq(otpChallenges.purpose, purpose),
          isNull(otpChallenges.consumedAt),
        ),
      );

    await tx.insert(otpChallenges).values({
      id: newId(),
      identifier,
      channel: 'email',
      purpose,
      codeHash: hashToken(code),
      maxAttempts: MAX_ATTEMPTS,
      expiresAt: new Date(Date.now() + CODE_TTL_MINUTES * 60_000),
      requestIp,
    });
  });

  return code;
}

export type CodeResult = 'ok' | 'invalid' | 'expired' | 'too_many_attempts';

/**
 * Check a code and consume it.
 *
 * A wrong guess costs an attempt; the fifth ends the challenge rather than the
 * request, so brute force needs a fresh code (and therefore a fresh email) per
 * five guesses. Everything is done against the *live* row inside one statement
 * chain, so two concurrent attempts cannot both win.
 */
export async function consumeCode(
  db: Database,
  identifier: string,
  purpose: CodePurpose,
  code: string,
): Promise<CodeResult> {
  const [row] = await db
    .select()
    .from(otpChallenges)
    .where(
      and(
        eq(otpChallenges.identifier, identifier),
        eq(otpChallenges.purpose, purpose),
        isNull(otpChallenges.consumedAt),
      ),
    )
    .orderBy(raw`${otpChallenges.createdAt} desc`)
    .limit(1);

  if (!row) return 'invalid';
  if (row.expiresAt.getTime() < Date.now()) return 'expired';
  if (row.attempts >= row.maxAttempts) return 'too_many_attempts';

  if (row.codeHash !== hashToken(code)) {
    const attempts = row.attempts + 1;
    await db
      .update(otpChallenges)
      .set({
        attempts,
        // Burn the challenge on the last attempt: leaving it alive would let
        // the counter be reset by nothing more than patience.
        ...(attempts >= row.maxAttempts ? { consumedAt: new Date() } : {}),
      })
      .where(eq(otpChallenges.id, row.id));
    return attempts >= row.maxAttempts ? 'too_many_attempts' : 'invalid';
  }

  const consumed = await db
    .update(otpChallenges)
    .set({ consumedAt: new Date() })
    .where(and(eq(otpChallenges.id, row.id), isNull(otpChallenges.consumedAt)))
    .returning({ id: otpChallenges.id });

  // Lost the race with another request holding the same code.
  return consumed.length > 0 ? 'ok' : 'invalid';
}
