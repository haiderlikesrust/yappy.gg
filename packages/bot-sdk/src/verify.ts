import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify a webhook delivery.
 *
 * Every delivery carries `X-Yappy-Signature`: HMAC-SHA256 of the **exact raw
 * body**, hex. Bots must check it before trusting anything in the payload. A
 * webhook URL leaks eventually — logs, config repos, a screen share — and an
 * unverified endpoint then accepts fabricated "the admin pressed approve"
 * events from anyone who found it.
 *
 * @param rawBody the body **as bytes or the original string**, not a re-encoded
 *   `JSON.stringify(parsed)`. Round-tripping through parse and stringify
 *   reorders keys and drops whitespace, and the signature is over what was
 *   sent, so a re-encoded body fails to verify for reasons that look like a
 *   broken secret. This is the single most common way to get this wrong, which
 *   is why `createHandler` takes the raw body rather than a parsed object.
 * @param signature the `X-Yappy-Signature` header, verbatim.
 * @param secret the webhook secret shown once when you set the webhook.
 */
export function verifySignature(
  // `Uint8Array` rather than `Buffer`: a Buffer is one, so every Node caller is
  // unaffected, and the published types no longer oblige a consumer to have
  // `@types/node` installed to typecheck against this package.
  rawBody: string | Uint8Array,
  signature: string | undefined | null,
  secret: string,
): boolean {
  if (!signature) return false;

  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');

  // Constant time, so a wrong signature cannot be brute-forced a byte at a
  // time by measuring how long the comparison took.
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
