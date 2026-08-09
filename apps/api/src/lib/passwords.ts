import { hash, verify } from '@node-rs/argon2';

/**
 * Password hashing.
 *
 * Argon2id, which is the current answer for a human-chosen secret: memory-hard,
 * so an attacker with GPUs does not get the enormous advantage they enjoy
 * against SHA-family hashes. (Bot tokens are hashed with plain SHA-256 instead
 * — see `applications` for why that is right there and wrong here.)
 *
 * Parameters are the OWASP baseline: 19 MiB, two passes, one lane. The memory
 * cost is the part that matters; iterations are cheap to raise later and the
 * stored hash records its own parameters, so raising them does not invalidate
 * existing passwords.
 */
const PARAMS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

/**
 * A hash of nothing anyone can log in with, verified against when the account
 * does not exist.
 *
 * Without it, "no such user" returns in a millisecond while a real account
 * takes the full Argon2 cost, and the difference is a reliable oracle for
 * which email addresses are registered. Computed once at startup.
 */
let decoyHash: Promise<string> | null = null;
function decoy(): Promise<string> {
  decoyHash ??= hash('yappy-timing-decoy-not-a-real-password', PARAMS);
  return decoyHash;
}

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, PARAMS);
}

/**
 * Check a password. Pass `null` when the account was not found — the work is
 * done anyway so the response takes the same time either way.
 */
export async function verifyPassword(stored: string | null, plain: string): Promise<boolean> {
  if (!stored) {
    await verify(await decoy(), plain).catch(() => false);
    return false;
  }
  // A malformed hash in the column must read as "wrong password", not as a
  // 500 that tells the caller something unusual is true of this account.
  return verify(stored, plain).catch(() => false);
}
