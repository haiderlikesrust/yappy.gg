/**
 * Exercises the attachment path exactly as the Android client does:
 * presign → PUT → confirm → send → fetch back through the authorised route.
 *
 * The interesting part is the PUT: S3 signs Content-Type and Content-Length
 * into the URL, so a client that sends either differently gets a 403 from the
 * bucket. That is the failure this script exists to catch.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
const API = 'http://localhost:3000/v1';
const LOG = process.env.WORKER_LOG;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, body, auth) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {} };
}

function latestCode(phone) {
  const log = readFileSync(LOG, 'utf8').replace(ANSI, '');
  const re = new RegExp(`to: "${phone.replace('+', '\\+')}"[\\s\\S]{0,160}?code: "(\\d{6})"`, 'g');
  let last = null, m;
  while ((m = re.exec(log)) !== null) last = m[1];
  return last;
}

async function signIn(phone) {
  await call('POST', '/auth/otp/request', { phone });
  await sleep(5000);
  const verified = await call('POST', '/auth/otp/verify', {
    phone, code: latestCode(phone), client: { platform: 'web', version: '1.0.0' },
  });
  if (verified.status !== 200) throw new Error(`${phone}: ${JSON.stringify(verified.json)}`);
  return { auth: `Bearer ${verified.json.accessToken}`, needsOnboarding: verified.json.needsOnboarding };
}

let failures = 0;
const ok = (label, extra = '') => console.log(`  ok   ${label}${extra ? ' — ' + extra : ''}`);
const bad = (label, detail) => { failures++; console.log(`  FAIL ${label} — ${detail}`); };

// A real 1x1 PNG — small, but a genuine image with a decodable header.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const ada = (await signIn('+15550000001')).auth;
const convs = await call('GET', '/conversations', null, ada);
const group = convs.json.conversations.find((c) => c.title === 'Backend crew');

console.log('\n── presign ────────────────────────────────────────');
const checksum = createHash('sha256').update(PNG).digest('hex');
const created = await call('POST', '/media/uploads', {
  filename: 'pixel.png',
  mimeType: 'image/png',
  size: PNG.length,
  purpose: 'attachment',
  width: 1,
  height: 1,
  checksum,
}, ada);

// 201 with a presigned target, or 200 when the checksum matched something
// already stored — re-running this script exercises the dedupe path.
if (created.status === 201) ok('presigned', `media ${created.json.media.id}`);
else if (created.status === 200 && created.json.deduplicated) ok('deduplicated by checksum', created.json.media.id);
else bad('presign', `${created.status} ${JSON.stringify(created.json)}`);

const target = created.json.upload;
const mediaId = created.json.media.id;

console.log('\n── PUT to the bucket ──────────────────────────────');
if (!target) {
  ok('deduplicated — no upload needed');
} else {
  // Mirror AttachmentUploader: skip content-length (the HTTP client sets it)
  // and send content-type from the same string we presigned with.
  const headers = {};
  for (const [k, v] of Object.entries(target.headers ?? {})) {
    const key = k.toLowerCase();
    if (key !== 'content-length' && key !== 'content-type') headers[k] = v;
  }
  headers['content-type'] = 'image/png';

  // Presigned URLs are now signed for the *emulator's* view of the host. This
  // script runs on the host, where that address is not routable — and the Host
  // header is part of the signature, so the rewrite has to be told to MinIO
  // too, via the Host header we send.
  const signedUrl = new URL(target.url);
  const signedHost = signedUrl.host;
  if (signedUrl.hostname === '10.0.2.2') signedUrl.hostname = 'localhost';

  const put = await fetch(signedUrl, { method: 'PUT', headers: { ...headers, host: signedHost }, body: PNG });
  if (put.ok) ok('PUT accepted by the bucket', `${put.status}`);
  else bad('PUT rejected', `${put.status} ${(await put.text()).slice(0, 200)}`);
}

console.log('\n── confirm ────────────────────────────────────────');
const confirmed = await call('POST', `/media/${mediaId}/confirm`, null, ada);
if (confirmed.status === 200) ok('confirmed', `status=${confirmed.json.media.status} size=${confirmed.json.media.size}`);
else bad('confirm', JSON.stringify(confirmed.json));

const contentUrl = confirmed.json.media?.url;
console.log(`  url: ${contentUrl}`);

console.log('\n── send + fetch back ──────────────────────────────');
const sent = await call('POST', `/conversations/${group.id}/messages`, {
  nonce: `upload_${Date.now()}`, type: 'image', attachmentIds: [mediaId], content: 'a single pixel',
}, ada);
if (sent.status === 201) ok('message sent', `seq ${sent.json.message.seq}`);
else bad('send', JSON.stringify(sent.json));

const authed = await fetch(contentUrl, { headers: { authorization: ada } });
const bytes = Buffer.from(await authed.arrayBuffer());
if (authed.ok && bytes.length === PNG.length) ok('member fetch', `${authed.status}, ${bytes.length} bytes, ${authed.headers.get('content-type')}`);
else bad('member fetch', `${authed.status} got ${bytes.length} bytes`);

const anon = await fetch(contentUrl);
anon.status === 401 ? ok('anonymous fetch rejected', '401') : bad('anonymous fetch', `expected 401, got ${anon.status}`);

// Someone with a valid account who is not in the conversation must get 404.
const strangerPhone = `+1555${String(Date.now()).slice(-7)}`;
const stranger = await signIn(strangerPhone);
const strangerFetch = await fetch(contentUrl, { headers: { authorization: stranger.auth } });
strangerFetch.status === 404
  ? ok('non-member fetch rejected', '404')
  : bad('non-member fetch', `expected 404, got ${strangerFetch.status}`);

console.log('\n───────────────────────────────────────────────────');
console.log(failures === 0 ? '✓ upload path works end to end' : `✗ ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
