/**
 * Sends a message as one of the seeded users, for manually verifying that the
 * Android client receives it live over the gateway.
 *
 *   node scripts/send-as.mjs +15550000002 <conversationId> "text"
 */
import { readFileSync } from 'node:fs';

const [phone, conversationId, ...rest] = process.argv.slice(2);
const text = rest.join(' ') || 'hello from the backend';
/** pino-pretty colour codes. The ESC byte must be part of the pattern —
 *  stripping only the bracketed part leaves stray escapes behind. */
const ANSI = /\u001b\[[0-9;]*m/g;

const API = 'http://localhost:3000/v1';
const LOG = process.env.WORKER_LOG ?? '/tmp/worker.log';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, body, token) {
  const res = await fetch(API + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {} };
}

function latestCode(phone) {
  const log = readFileSync(LOG, 'utf8').replace(ANSI, '');
  const re = new RegExp(`to: "${phone.replace('+', '\\+')}"\\s*\\n\\s*code: "(\\d{6})"`, 'g');
  let last = null, m;
  while ((m = re.exec(log)) !== null) last = m[1];
  return last;
}

const requested = await call('POST', '/auth/otp/request', { phone });
if (requested.status !== 200) {
  console.error('otp/request failed', requested.status, requested.json);
  process.exit(1);
}

// Fixed settle, then take the newest code. Comparing against a "before" value
// races when a previous run left an identical code in the log.
await sleep(4_000);
const code = latestCode(phone);
if (!code) {
  console.error('no code found in', LOG);
  process.exit(1);
}

const verified = await call('POST', '/auth/otp/verify', {
  phone,
  code,
  client: { platform: 'web', version: '1.0.0' },
});

if (verified.status !== 200) {
  console.error('sign-in failed', verified.json);
  process.exit(1);
}

const sent = await call(
  'POST',
  `/conversations/${conversationId}/messages`,
  { nonce: `cli_${Date.now()}`, type: 'text', content: text },
  verified.json.accessToken,
);

console.log(sent.status, JSON.stringify(sent.json.message?.content), 'seq', sent.json.message?.seq);
