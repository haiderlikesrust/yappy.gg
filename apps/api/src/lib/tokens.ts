import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { env } from '../env.js';

/**
 * Two-token scheme.
 *
 *   Access  — short-lived JWT, verified with no database round trip. Carries
 *             the device id so a single revoked device can be identified, and
 *             a `tokenEpoch` so "log out everywhere" invalidates outstanding
 *             tokens without a revocation list.
 *   Refresh — opaque 256-bit random string, only its SHA-256 stored. Rotated
 *             on every use, with the previous hash retained briefly so a retry
 *             on a dropped response does not log the user out.
 *
 * The gateway verifies the same access token, which is why this lives in a
 * module with no Fastify dependency.
 */

const secret = new TextEncoder().encode(env.JWT_SECRET);
const ALG = 'HS256';

export interface AccessClaims extends JWTPayload {
  sub: string;
  /** Device (session) id. */
  did: string;
  /** users.token_epoch at mint time. */
  ep: number;
  typ: 'access';
}

export async function signAccessToken(userId: string, deviceId: string, epoch: number): Promise<string> {
  return new SignJWT({ did: deviceId, ep: epoch, typ: 'access' })
    .setProtectedHeader({ alg: ALG })
    .setSubject(userId)
    .setIssuer(env.JWT_ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${env.ACCESS_TOKEN_TTL}s`)
    .sign(secret);
}

export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, secret, {
    issuer: env.JWT_ISSUER,
    algorithms: [ALG],
  });
  if (payload.typ !== 'access' || typeof payload.sub !== 'string' || typeof payload.did !== 'string') {
    throw new Error('malformed access token');
  }
  return payload as AccessClaims;
}

/**
 * Short-lived token handed to the client specifically to open the WebSocket.
 * Scoped so that a token leaked from a URL (query strings end up in proxy logs)
 * cannot be replayed against the REST API.
 */
export async function signGatewayTicket(userId: string, deviceId: string, epoch: number): Promise<string> {
  return new SignJWT({ did: deviceId, ep: epoch, typ: 'gateway' })
    .setProtectedHeader({ alg: ALG })
    .setSubject(userId)
    .setIssuer(env.JWT_ISSUER)
    .setIssuedAt()
    .setExpirationTime('60s')
    .sign(secret);
}

export function newRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/** Constant-time compare for anything derived from user input. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Six digits, uniformly distributed. `Math.random()` is not acceptable here. */
export function newOtpCode(): string {
  let code = '';
  const bytes = randomBytes(6);
  for (let i = 0; i < 6; i++) code += (bytes[i]! % 10).toString();
  return code;
}

export const hashOtp = (code: string, identifier: string): string =>
  createHash('sha256').update(`${identifier}:${code}:${env.JWT_SECRET}`).digest('hex');

/**
 * Bot token.
 *
 * Prefixed so it is recognisable in a leak scan (GitHub's secret scanning keys
 * off exactly this kind of marker) and so a human pasting one into the wrong
 * box can see what it is. 256 bits of entropy after the prefix.
 */
export function newBotToken(): { token: string; hash: string; prefix: string } {
  const secretPart = randomBytes(32).toString('base64url');
  const token = `yb_${secretPart}`;
  return { token, hash: hashToken(token), prefix: token.slice(0, 11) };
}

/** URL-safe invite code. Excludes look-alike characters — these get read aloud. */
export function newInviteCode(length = 10): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}

// ─── Developer portal ────────────────────────────────────────────────────────

export interface PortalClaims extends JWTPayload {
  sub: string;
  typ: 'portal';
}

/**
 * A session for the developer portal, deliberately *not* an access token.
 *
 * `typ` is checked on verify, so this cannot be replayed against the app's API
 * even though it is signed with the same secret. That separation is the point:
 * the portal manages bots and applications, and a session stolen from a laptop
 * browser should not also be able to read the owner's direct messages.
 *
 * Short-lived and not refreshable. Signing in again costs one message to a bot.
 */
export async function signPortalToken(userId: string): Promise<string> {
  return new SignJWT({ typ: 'portal' })
    .setProtectedHeader({ alg: ALG })
    .setSubject(userId)
    .setIssuer(env.JWT_ISSUER)
    .setIssuedAt()
    .setExpirationTime('8h')
    .sign(secret);
}

export async function verifyPortalToken(token: string): Promise<PortalClaims> {
  const { payload } = await jwtVerify(token, secret, {
    issuer: env.JWT_ISSUER,
    algorithms: [ALG],
  });
  if (payload.typ !== 'portal' || typeof payload.sub !== 'string') {
    throw new Error('not a portal token');
  }
  return payload as PortalClaims;
}

/**
 * The code a human retypes into the app.
 *
 * Two groups of four from an alphabet with no look-alikes, because this gets
 * read off one screen and typed into another. Short enough to be bearable,
 * which is only safe because the grant expires in minutes, allows a handful of
 * attempts, and is rate limited per user.
 */
export function newUserCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) {
    if (i === 4) out += '-';
    out += alphabet[bytes[i]! % alphabet.length];
  }
  return out;
}

/** Opaque handle the browser polls with. Never seen by a person. */
export function newPollToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}
