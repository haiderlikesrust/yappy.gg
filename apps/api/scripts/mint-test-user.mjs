/**
 * Mint a signed-in test account without going through OTP.
 *
 *   node --env-file=../../.env scripts/mint-test-user.mjs alice "Alice"
 *   → {"id":"…","username":"alice_…","accessToken":"…"}
 *
 * Verification scripts used to sign up over OTP and scrape the code out of the
 * worker's log. That coupled every test run to a running worker, to log
 * formatting, and to the OTP rate limiter — which is what made a five-second
 * suite take seven minutes. None of that is the thing under test.
 *
 * DEVELOPMENT ONLY. This signs a token with JWT_SECRET directly, which is
 * exactly the capability the auth routes exist to withhold. It refuses to run
 * against a production-looking configuration.
 */
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
const jwtSecret = process.env.JWT_SECRET;

if (!url || !jwtSecret) {
  console.error('DATABASE_URL and JWT_SECRET must be set. Run with --env-file=../../.env');
  process.exit(1);
}
if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to mint tokens in production.');
  process.exit(1);
}

const [, , handle = 'test', displayName = 'Test User'] = process.argv;
const suffix = randomUUID().slice(0, 8);
const username = `${handle}_${suffix}`.slice(0, 30);

const sql = postgres(url, { max: 1 });

try {
  const userId = randomUUID();
  const deviceId = randomUUID();

  await sql.begin(async (tx) => {
    // Having a username *is* being onboarded — see `needsOnboarding` in the
    // auth route. There is no separate flag to set.
    await tx`
      insert into users (id, username, display_name)
      values (${userId}, ${username}, ${displayName})`;
    await tx`
      insert into devices (id, user_id, platform, app_version)
      values (${deviceId}, ${userId}, 'web', '1.0.0-test')`;
  });

  const accessToken = await new SignJWT({ did: deviceId, ep: 0, typ: 'access' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(process.env.JWT_ISSUER ?? 'yappy')
    .setIssuedAt()
    .setExpirationTime(`${process.env.ACCESS_TOKEN_TTL ?? 900}s`)
    .sign(new TextEncoder().encode(jwtSecret));

  console.log(JSON.stringify({ id: userId, username, accessToken }));
} finally {
  await sql.end();
}
