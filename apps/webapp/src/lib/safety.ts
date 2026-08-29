import { api } from './api';

/**
 * Noticing when somebody's safety number changes.
 *
 * A safety number is one value over every device a person currently has, so it
 * changes when they add a phone, reinstall, or sign in somewhere new. It also
 * changes when somebody has quietly published a device of their own in their
 * name and is reading everything — and those two look identical from here.
 * That is the whole reason to say something: the innocent explanation is far
 * more likely, and the other one is invisible unless it is surfaced.
 *
 * The ratchet makes this matter more, not less. A message from a sender whose
 * session this device cannot follow rebuilds the session from the preamble and
 * carries on, which is right — people do reinstall — but it means an
 * interception is a silent recovery unless somebody is told.
 *
 * What is remembered here is only what this device last saw. It is not secret
 * and it is not a claim about anybody: `verified` on the server is the claim,
 * and it expires by itself when the number changes.
 */

const SEEN = 'yappy.safety.seen';

interface Directory {
  safetyNumber: string;
  verified: boolean;
  changedSinceVerified: boolean;
}

export interface SafetyState {
  userId: string;
  safetyNumber: string;
  /** Different from what this device last saw. */
  changed: boolean;
  /** And they had been compared in person, which is the louder case. */
  wasVerified: boolean;
}

function seen(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(SEEN) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

function remember(userId: string, safetyNumber: string): void {
  localStorage.setItem(SEEN, JSON.stringify({ ...seen(), [userId]: safetyNumber }));
}

/**
 * Whether this person's devices are what they were last time.
 *
 * The first sight of somebody is never a change — there is nothing to compare
 * against, and warning about it would train people to dismiss the warning that
 * matters. It is recorded silently instead.
 */
export async function checkSafety(userId: string): Promise<SafetyState | null> {
  try {
    const directory = await api<Directory>(`/keys/user/${userId}`);
    const previous = seen()[userId];

    /**
     * Two different questions, and only one of them belongs in a banner.
     *
     * "Did their devices change since this browser last looked" is the notice —
     * it has an end, because being told once is the point. "Is there a
     * verification that no longer matches" is a standing fact about a badge,
     * and it lives on the safety-number screen where it can say so for as long
     * as it is true. Mixing them gives a notice that cannot be dismissed, which
     * teaches people to ignore the one that matters.
     *
     * The exception is the first sight of somebody who was already verified and
     * has already changed: nothing here has ever seen their number, but they
     * are owed the notice anyway.
     */
    const changed =
      previous === undefined
        ? directory.changedSinceVerified
        : previous !== directory.safetyNumber;

    if (!changed) {
      remember(userId, directory.safetyNumber);
      return null;
    }

    // Deliberately not recorded here. Dismissing the banner is what records it,
    // so a notice nobody saw is not one that has been delivered.
    return {
      userId,
      safetyNumber: directory.safetyNumber,
      changed: true,
      wasVerified: directory.verified || directory.changedSinceVerified,
    };
  } catch {
    // No keys published, or the request failed. Neither is something to alarm
    // somebody about — this feature only speaks when it knows something.
    return null;
  }
}

/**
 * "I have seen this."
 *
 * Deliberately separate from verifying: dismissing the notice means the person
 * has been told, not that anybody compared anything. The server-side
 * verification is its own act with its own record, and this must never be
 * mistaken for it.
 */
export function acknowledgeSafety(userId: string, safetyNumber: string): void {
  remember(userId, safetyNumber);
}
