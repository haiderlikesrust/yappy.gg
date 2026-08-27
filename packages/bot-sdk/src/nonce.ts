/**
 * An idempotency key.
 *
 * Every send needs one: the server treats a repeated nonce from the same
 * sender as the same message and hands back the original rather than posting a
 * second copy. That is what makes a retry after a timeout safe, which is the
 * one thing a bot on a flaky connection needs most.
 *
 * Generated when the caller does not supply one, because "the send failed and
 * did not say why" is a poor introduction to a platform. Pass your own when a
 * retry of *your* logic — a redelivered webhook, a restarted process picking up
 * where it left off — must not post twice.
 */
export function newNonce(prefix = 'sdk'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
