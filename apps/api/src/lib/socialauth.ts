import { and, authIdentities, eq, isNull, users, type Database } from '@yappy/db';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { env } from '../env.js';

/**
 * Social sign-in verification.
 *
 * The client hands us the provider's ID token; nothing else crosses the wire.
 * Verification is the standard OIDC check — signature against the provider's
 * published JWKS, issuer, audience, expiry — done by jose, with the key sets
 * cached module-level (jose refreshes them on rotation by itself).
 *
 * What comes back is deliberately small: the provider's *stable* subject id,
 * and the identity fields needed to create or match an account. Email is
 * trusted as verified only when the provider says so — that claim is what the
 * account-linking rules in the route lean on.
 */

export interface SocialIdentity {
  provider: 'google' | 'apple';
  /** The provider's stable user id. Never the email. */
  subject: string;
  email: string | null;
  emailVerified: boolean;
  /** Display name, when the provider shares one. */
  name: string | null;
}

const googleJwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const appleJwks = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));

export async function verifyGoogleToken(idToken: string): Promise<SocialIdentity> {
  const audiences = env.GOOGLE_CLIENT_IDS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (audiences.length === 0) {
    throw new Error('google_disabled');
  }

  const { payload } = await jwtVerify(idToken, googleJwks, {
    // Google has historically used both forms.
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    audience: audiences,
  });

  return {
    provider: 'google',
    subject: String(payload.sub),
    email: typeof payload.email === 'string' ? payload.email.toLowerCase() : null,
    emailVerified: payload.email_verified === true || payload.email_verified === 'true',
    name: typeof payload.name === 'string' ? payload.name : null,
  };
}

export async function verifyAppleToken(idToken: string): Promise<SocialIdentity> {
  const { payload } = await jwtVerify(idToken, appleJwks, {
    issuer: 'https://appleid.apple.com',
    audience: env.APPLE_BUNDLE_ID,
  });

  return {
    provider: 'apple',
    subject: String(payload.sub),
    // Present on first authorization (and for private-relay addresses,
    // which are real, routable and fine).
    email: typeof payload.email === 'string' ? payload.email.toLowerCase() : null,
    // Apple sends this as a string on some tokens and a boolean on others.
    emailVerified: payload.email_verified === true || payload.email_verified === 'true',
    // Apple never puts the name in the token; the client forwards it once.
    name: null,
  };
}

/**
 * A username nobody chose.
 *
 * Social accounts skip the registration form, and `authenticateOnboarded`
 * requires a username, so one is derived from the email's local part —
 * sanitised to the username grammar, uniquified with digits when taken. The
 * person can change it in Settings, where the rename machinery (history,
 * rate limit) already lives; this just has to be inoffensive and available.
 */
export async function availableUsername(db: Database, seed: string | null): Promise<string> {
  const base =
    (seed ?? '')
      .split('@')[0]!
      .toLowerCase()
      .replace(/[^a-z0-9_.]/g, '')
      .replace(/[_.]{2,}/g, '_')
      .replace(/^[_.]+|[_.]+$/g, '')
      .slice(0, 24) || 'yappy';
  const padded = base.length >= 3 ? base : `${base}${'123'.slice(base.length - 3)}`;

  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate =
      attempt === 0 ? padded : `${padded}${Math.floor(Math.random() * 9000) + 1000}`;
    const [taken] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.username, candidate), isNull(users.deletedAt)))
      .limit(1);
    if (!taken) return candidate;
  }
  // Twenty collisions on random 4-digit suffixes means the base is radioactive.
  return `yappy_${Date.now().toString(36)}`;
}

/** The identity row, if this provider subject has signed in before. */
export async function findIdentity(
  db: Database,
  provider: string,
  subject: string,
): Promise<{ userId: string } | null> {
  const [row] = await db
    .select({ userId: authIdentities.userId })
    .from(authIdentities)
    .where(and(eq(authIdentities.provider, provider), eq(authIdentities.subject, subject)))
    .limit(1);
  return row ?? null;
}
