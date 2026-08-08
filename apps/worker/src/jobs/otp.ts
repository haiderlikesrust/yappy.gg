import type { Logger } from 'pino';
import { env } from '../env.js';

/**
 * OTP delivery.
 *
 * Runs in the worker, not the API, so a slow or flapping SMS provider never
 * shows up as latency on the login endpoint. The trade-off is that delivery
 * failure is invisible to the caller — which is correct anyway: telling a
 * caller "we could not send to that number" is an account-existence oracle.
 */

interface OtpJob {
  identifier: string;
  channel: 'sms' | 'email';
  code: string;
  purpose: string;
}

export async function deliverOtp(log: Logger, job: OtpJob): Promise<void> {
  if (job.channel === 'sms') return deliverSms(log, job);
  return deliverEmail(log, job);
}

async function deliverSms(log: Logger, job: OtpJob): Promise<void> {
  // The message format matters on iOS/Android: including the domain and the
  // literal "@yappy.gg #<code>" line lets the OS autofill the code.
  const body = `${job.code} is your yappy code.\n\n@yappy.gg #${job.code}`;

  if (env.SMS_PROVIDER === 'console') {
    log.warn({ to: job.identifier, code: job.code }, '📱 SMS (console provider — development only)');
    return;
  }

  const auth = Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64');
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,
    {
      method: 'POST',
      headers: {
        authorization: `Basic ${auth}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: job.identifier, From: env.TWILIO_FROM, Body: body }),
      signal: AbortSignal.timeout(10_000),
    },
  );

  if (!res.ok) {
    // Throwing hands it back to pg-boss, which retries with backoff.
    throw new Error(`twilio ${res.status}: ${await res.text()}`);
  }
}

async function deliverEmail(log: Logger, job: OtpJob): Promise<void> {
  const subject = `${job.code} is your yappy code`;
  const text = `Your verification code is ${job.code}.\n\nIt expires in 5 minutes. If you did not request it, ignore this email.`;

  if (env.EMAIL_PROVIDER === 'console') {
    log.warn({ to: job.identifier, code: job.code }, '✉️  Email (console provider — development only)');
    return;
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: job.identifier, subject, text }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) throw new Error(`resend ${res.status}: ${await res.text()}`);
}
