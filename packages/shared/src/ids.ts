import { uuidv7 } from 'uuidv7';

/**
 * Every entity uses a UUIDv7 primary key.
 *
 * Why v7 and not v4: the first 48 bits are a millisecond timestamp, so ids sort
 * chronologically. That gives us B-tree locality on insert (no random-page
 * churn on a table taking thousands of writes/second) and lets us paginate by
 * primary key without a secondary `created_at` index.
 *
 * Message *ordering* inside a conversation does not rely on this — see the
 * per-conversation `seq` counter in packages/db/src/schema/messages.ts. UUIDv7
 * is only millisecond-precise, which is not enough to disambiguate two messages
 * sent in the same tick.
 */
export function newId(): string {
  return uuidv7();
}

/** Extract the embedded creation time from a UUIDv7. */
export function idTimestamp(id: string): Date {
  const hex = id.replace(/-/g, '').slice(0, 12);
  return new Date(Number.parseInt(hex, 16));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Canonical key for a 1:1 conversation, used by a unique index so two people
 * can never end up with two parallel DM threads (a classic race when both tap
 * "message" at the same moment).
 */
export function dmKey(userA: string, userB: string): string {
  return userA < userB ? `${userA}:${userB}` : `${userB}:${userA}`;
}
