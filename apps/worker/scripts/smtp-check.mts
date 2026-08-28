/**
 * Prove the SMTP path end to end without a real mailbox.
 *
 * Stands up a throwaway SMTP server on localhost, sends one message through the
 * real `handleEmail`, and prints what the server received — the envelope, the
 * headers and the body. Everything a mailbox provider would do with it after
 * that is their business; everything this codebase controls is visible here.
 *
 *   pnpm --filter @yappy/worker smtp-check
 */
import { writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';

const PORT = 2525;

process.env.EMAIL_PROVIDER = 'smtp';
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = String(PORT);
process.env.SMTP_SECURE = 'false';
process.env.SMTP_USER = 'hello@yappy.gg';
process.env.SMTP_PASSWORD = 'not-a-real-password';
process.env.EMAIL_FROM = 'yappy <hello@yappy.gg>';
// The worker's env schema wants the rest of the world to exist.
process.env.DATABASE_URL ??= 'postgres://localhost:5432/none';

const received: string[] = [];

const server = createServer((socket: Socket) => {
  let inData = false;
  socket.write('220 localhost ESMTP test\r\n');
  socket.on('data', (chunk) => {
    const text = chunk.toString();
    if (inData) {
      received.push(text);
      if (text.includes('\r\n.\r\n')) {
        inData = false;
        socket.write('250 OK queued\r\n');
      }
      return;
    }
    for (const line of text.split('\r\n').filter(Boolean)) {
      received.push(line);
      const verb = line.split(' ')[0]?.toUpperCase();
      if (verb === 'EHLO' || verb === 'HELO') socket.write('250-localhost\r\n250 AUTH PLAIN LOGIN\r\n');
      else if (verb === 'AUTH') socket.write('235 authenticated\r\n');
      else if (verb === 'MAIL' || verb === 'RCPT') socket.write('250 OK\r\n');
      else if (verb === 'DATA') {
        inData = true;
        socket.write('354 go ahead\r\n');
      } else if (verb === 'QUIT') {
        socket.write('221 bye\r\n');
        socket.end();
      } else socket.write('250 OK\r\n');
    }
  });
});

await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', resolve));

const { handleEmail } = await import('../src/jobs/email.js');
const { resetEmail } = await import('../../api/src/lib/mailer.js');

const log = {
  info: (...a: unknown[]) => console.log('  log:', JSON.stringify(a[1] ?? a[0])),
  error: console.error,
} as never;

const preview = process.env.MAIL_PREVIEW ?? '';
const letter = resetEmail('424242', 15);
await handleEmail(log, { to: 'someone@example.test', ...letter });

if (preview) {
  writeFileSync(preview, letter.html, 'utf8');
  console.log(`  wrote ${preview}`);
}

server.close();

const transcript = received.join('\n');
const checks: Array<[string, boolean]> = [
  ['authenticated', /AUTH (PLAIN|LOGIN)/i.test(transcript)],
  ['envelope from is the mailbox', transcript.includes('MAIL FROM:<hello@yappy.gg>')],
  ['envelope to is the recipient', transcript.includes('RCPT TO:<someone@example.test>')],
  ['From header carries the display name', /From: yappy <hello@yappy\.gg>/.test(transcript)],
  ['subject leads with the code', /Subject: 424242 is your yappy password reset code/.test(transcript)],
  ['body carries the code', transcript.includes('424242')],
  ['both parts sent', /Content-Type: multipart\/alternative/i.test(transcript)],
  ['plain text part', /Content-Type: text\/plain/i.test(transcript)],
  ['html part', /Content-Type: text\/html/i.test(transcript)],
  ['html carries the code', /424242/.test(letter.html)],
  // The logo may be blocked — most clients do block it — so what matters is
  // that nothing depends on it arriving.
  ['logo carries alt text', /<img[^>]+alt="yappy"/.test(letter.html)],
  ['wordmark is text, not the image', letter.html.includes('>yappy<span')],
  ['every colour also inline', !/var\(--/.test(letter.html)],
];

console.log('');
for (const [what, ok] of checks) console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
const failed = checks.filter(([, ok]) => !ok).length;
console.log(`\n${failed === 0 ? 'all green' : `${failed} failure(s)`}\n`);
process.exit(failed === 0 ? 0 : 1);
