import type postgres from 'postgres';
import { rateLimited } from '@yappy/shared';

/**
 * Token-bucket limiter backed by `consume_rate_limit()` in Postgres.
 *
 * A per-process cache sits in front of it. The observation: the overwhelming
 * majority of rate-limit checks pass with the bucket nowhere near empty, and
 * paying a database round trip to learn that is wasteful. So a subject whose
 * bucket was recently observed as comfortably full is allowed locally, and only
 * subjects approaching their limit are checked against Postgres.
 *
 * The trade-off is that a user spread across N API nodes can burst up to N×
 * the local allowance before the shared bucket catches them. That is
 * acceptable for abuse throttling and unacceptable for anything billing-related
 * — hence `exact: true` on the buckets that must not be approximated.
 */

export interface Bucket {
  /** Burst size. */
  capacity: number;
  /** Sustained rate. */
  refillPerSecond: number;
  /** Skip the local cache and always hit Postgres. */
  exact?: boolean;
}

export const BUCKETS = {
  // Auth: tight, and deliberately expensive to brute force.
  'auth.refresh': { capacity: 30, refillPerSecond: 1 / 10 },

  /** Unauthenticated grant minting on the portal — one browser asking to be
   *  let in. Tight for the same reason OTP requests used to be: each one is a
   *  row in the database and a code someone could be socially engineered
   *  into approving. */
  'portal.grant': { capacity: 3, refillPerSecond: 1 / 120, exact: true },

  /**
   * Sign-in. Consumed twice per attempt: once against the email, once against
   * the source IP. The per-email bucket is what makes guessing one account's
   * password futile; the per-IP one is what stops a host spraying one common
   * password across thousands of accounts, which no per-account limit sees.
   *
   * Ten per email with a five-minute refill is generous for a typo and useless
   * for a dictionary.
   */
  'auth.login': { capacity: 10, refillPerSecond: 1 / 300, exact: true },
  /** Registration is per-IP only; there is no account to key on yet. */
  'auth.register': { capacity: 5, refillPerSecond: 1 / 600, exact: true },
  'auth.password.change': { capacity: 5, refillPerSecond: 1 / 300, exact: true },

  // Messaging: generous enough that a fast typist never sees it.
  'message.send': { capacity: 30, refillPerSecond: 5 },
  'message.edit': { capacity: 20, refillPerSecond: 2 },
  'message.delete': { capacity: 30, refillPerSecond: 2 },
  'message.forward': { capacity: 10, refillPerSecond: 0.5 },
  'reaction.add': { capacity: 50, refillPerSecond: 10 },
  'typing': { capacity: 20, refillPerSecond: 4 },
  /**
   * Screenshot notices, which a client reports and therefore a hostile one can
   * forge. It cannot be made truthful, but it can be made boring: a handful,
   * refilling slowly, so the worst case is a nuisance rather than a way to
   * fill somebody's chat.
   */
  'screenshot': { capacity: 5, refillPerSecond: 1 / 30 },
  /**
   * Live-location pings. A share sends one every ten to fifteen seconds for
   * hours, so the refill has to sustain that indefinitely rather than merely
   * absorb a burst — this is the one bucket where the steady rate matters more
   * than the capacity.
   */
  'location.ping': { capacity: 20, refillPerSecond: 1 },

  // Fan-out actions — the expensive ones.
  'conversation.create': { capacity: 10, refillPerSecond: 1 / 30 },
  'member.add': { capacity: 20, refillPerSecond: 1 / 10 },
  'invite.create': { capacity: 10, refillPerSecond: 1 / 60 },
  /**
   * The unauthenticated preview behind yappy.gg/join/<code>, keyed by source
   * address because there is no account to key on yet.
   *
   * A code is ten characters from a 31-letter alphabet, so roughly 49 bits —
   * guessing one is already hopeless. This is what stops someone trying anyway
   * at machine speed, and `exact` because a cached local allowance is exactly
   * the wrong answer for an unauthenticated enumeration surface.
   */
  'invite.preview': { capacity: 20, refillPerSecond: 1 / 5, exact: true },

  'media.upload': { capacity: 30, refillPerSecond: 1 },
  'call.start': { capacity: 10, refillPerSecond: 1 / 20 },
  'search': { capacity: 20, refillPerSecond: 1 },
  'gif.search': { capacity: 60, refillPerSecond: 5 },
  'contacts.sync': { capacity: 3, refillPerSecond: 1 / 3600, exact: true },
  'report.create': { capacity: 10, refillPerSecond: 1 / 300, exact: true },
  'follow': { capacity: 60, refillPerSecond: 1 / 10 },

  /**
   * Taking a new username.
   *
   * Not a cooldown for its own sake. A handle is what other people recognise
   * someone by, so "take the name someone just vacated, use it for an evening,
   * drop it again" is an impersonation move — and one that costs nothing if
   * changes are free. Two in hand covers a typo noticed straight after the
   * first change; a day's refill after that makes cycling too slow to be worth
   * anyone's time. `exact` because a per-node allowance would multiply by the
   * number of API instances, and this is a limit that has to actually hold.
   */
  'username.change': { capacity: 2, refillPerSecond: 1 / 86_400, exact: true },

  /**
   * The unauthenticated availability check behind the signup form.
   *
   * Answering "does this account exist" to anyone who asks is unavoidable —
   * a signup form has to say whether a name is free. What is avoidable is
   * answering it a thousand times a second, which turns the endpoint into a
   * way to enumerate the whole user table. Generous enough that someone trying
   * names as they type never notices.
   */
  'username.check': { capacity: 60, refillPerSecond: 1, exact: true },

  /**
   * The GitHub webhook, keyed by source address.
   *
   * The signature is what actually guards the endpoint; this bounds what an
   * unsigned caller can make us spend on an HMAC over a megabyte before we
   * refuse them. Sized well above real traffic — a busy repository merging all
   * day is a handful of deliveries a minute, not two a second.
   */
  'webhook.github': { capacity: 120, refillPerSecond: 2 },
} as const satisfies Record<string, Bucket>;

export type BucketName = keyof typeof BUCKETS;

/**
 * Development runs with the auth buckets widened.
 *
 * Not a shortcut — the numbers above are sized to make brute-forcing a
 * six-digit code pointless, which means three OTP requests per six minutes,
 * which in turn means an end-to-end test that signs up four accounts has to
 * idle for seven minutes before it can run again. That cost is paid on every
 * iteration and it is paid for nothing: there is no attacker on a laptop's
 * loopback interface.
 *
 * Only the auth buckets move, only outside production, and the shape stays the
 * same so the code path under test is the real one. Everything else keeps its
 * production numbers so a genuinely runaway loop still trips something.
 */
const DEV_AUTH_OVERRIDES: Partial<Record<BucketName, Bucket>> = {
  // A verification run signs up a handful of accounts from one address; at the
  // production numbers the second run of the day would be refused.
  'auth.login': { capacity: 200, refillPerSecond: 10, exact: true },
  'auth.register': { capacity: 200, refillPerSecond: 10, exact: true },
  'auth.password.change': { capacity: 100, refillPerSecond: 5, exact: true },
  'portal.grant': { capacity: 100, refillPerSecond: 5, exact: true },
  'contacts.sync': { capacity: 50, refillPerSecond: 1, exact: true },
};

export function bucketFor(name: BucketName, isProduction: boolean): Bucket {
  if (isProduction) return BUCKETS[name];
  return DEV_AUTH_OVERRIDES[name] ?? BUCKETS[name];
}

interface CacheEntry {
  tokens: number;
  updatedAt: number;
}

export class RateLimiter {
  private readonly cache = new Map<string, CacheEntry>();
  /** Bound the map so a flood of distinct IPs cannot exhaust memory. */
  private readonly maxCacheEntries = 50_000;

  constructor(
    private readonly sql: postgres.Sql,
    /** Production keeps the tight auth buckets; see DEV_AUTH_OVERRIDES. */
    private readonly isProduction = true,
  ) {}

  /** Throws a 429 with `retryAfter` when the bucket is empty. */
  async consume(subject: string, action: BucketName, cost = 1): Promise<void> {
    const bucket = bucketFor(action, this.isProduction);
    const key = `${subject}|${action}`;

    if (!bucket.exact) {
      const local = this.cache.get(key);
      const now = Date.now();
      if (local) {
        const refilled = Math.min(
          bucket.capacity,
          local.tokens + ((now - local.updatedAt) / 1000) * bucket.refillPerSecond,
        );
        // Only trust the local view while we are above half capacity. Near the
        // limit, defer to the shared bucket so the decision is actually correct.
        if (refilled - cost > bucket.capacity / 2) {
          this.cache.set(key, { tokens: refilled - cost, updatedAt: now });
          return;
        }
      }
    }

    const [row] = await this.sql<{ allowed: boolean; remaining: number; retry_after: number }[]>`
      select * from consume_rate_limit(
        ${subject}, ${action}, ${bucket.capacity}, ${bucket.refillPerSecond}, ${cost}
      )
    `;

    if (!row) return; // function unavailable — fail open rather than lock everyone out

    if (!bucket.exact) {
      if (this.cache.size >= this.maxCacheEntries) this.cache.clear();
      this.cache.set(key, { tokens: row.remaining, updatedAt: Date.now() });
    }

    if (!row.allowed) {
      throw rateLimited(Math.ceil(row.retry_after));
    }
  }

  /** Non-throwing variant for places that degrade instead of failing (typing). */
  async tryConsume(subject: string, action: BucketName, cost = 1): Promise<boolean> {
    try {
      await this.consume(subject, action, cost);
      return true;
    } catch {
      return false;
    }
  }
}
