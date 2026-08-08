/**
 * Keeps a seeded user online for N seconds: signs in, opens a gateway socket,
 * IDENTIFYs, heartbeats. Used to light up presence UI while screenshotting.
 *
 *   node ghost.mjs +15550000002 90
 */
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';

const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
const API = 'http://localhost:3000/v1';
const WS_URL = 'ws://localhost:3001';
const LOG = process.env.WORKER_LOG;

const [phone = '+15550000002', secondsArg = '90'] = process.argv.slice(2);
const seconds = Number(secondsArg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, body, token) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {} };
}

function latestCode(p) {
  const log = readFileSync(LOG, 'utf8').replace(ANSI, '');
  const re = new RegExp(`to: "${p.replace('+', '\\+')}"\\s*\\n\\s*code: "(\\d{6})"`, 'g');
  let last = null, m;
  while ((m = re.exec(log)) !== null) last = m[1];
  return last;
}

await call('POST', '/auth/otp/request', { phone });
await sleep(5000);
const verified = await call('POST', '/auth/otp/verify', {
  phone, code: latestCode(phone), client: { platform: 'web', version: '1.0.0' },
});
if (verified.status !== 200) { console.error('sign-in failed', verified.json); process.exit(1); }
const ticket = await call('POST', '/auth/gateway-ticket', null, verified.json.accessToken);

const ws = new WebSocket(WS_URL);
let interval = null;
ws.on('message', (raw) => {
  const f = JSON.parse(raw.toString());
  if (f.op === 0) {
    ws.send(JSON.stringify({ op: 1, d: { token: ticket.json.ticket, protocolVersion: 1, client: { platform: 'web', version: '1.0.0' }, cursors: [] } }));
    interval = setInterval(() => ws.send(JSON.stringify({ op: 3, d: {} })), f.d.heartbeatIntervalMs ?? 30000);
  }
  if (f.op === 2) console.log(`${phone} online for ${seconds}s`);
});
ws.on('error', (e) => { console.error('ws error', e.message); process.exit(1); });

setTimeout(() => { clearInterval(interval); ws.close(); process.exit(0); }, seconds * 1000);
