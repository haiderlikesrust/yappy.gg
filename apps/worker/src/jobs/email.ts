import type { Logger } from 'pino';
import { env } from '../env.js';

/**
 * Sending the mail the API asked for.
 *
 * On the queue rather than inline, for the ordinary reason: a provider having a
 * bad minute must not turn "reset my password" into a 500. The request writes
 * the code and hands the letter over; this delivers it, and pg-boss retries if
 * the provider is down.
 *
 * A duplicate delivery is harmless — the code inside is the same one — so this
 * needs no idempotency of its own beyond what the queue already gives it.
 */

export interface EmailJob {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export async function handleEmail(log: Logger, job: EmailJob): Promise<void> {
  if (!job.to) throw new Error('email job has no recipient');

  if (env.EMAIL_PROVIDER === 'console') {
    // This *is* the inbox in development, so it prints the body rather than a
    // line saying a body exists.
    console.log(
      [
        '',
        '── mail ──────────────────────────────',
        `to:      ${job.to}`,
        `subject: ${job.subject}`,
        '',
        job.text,
        '──────────────────────────────────────',
        '',
      ].join('\n'),
    );
    return;
  }

  if (!env.RESEND_API_KEY) throw new Error('EMAIL_PROVIDER is resend but RESEND_API_KEY is empty');

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [job.to],
      subject: job.subject,
      text: job.text,
      ...(job.html ? { html: job.html } : {}),
    }),
  });

  if (!res.ok) {
    // Thrown so the queue retries. The body is logged because "why did the mail
    // not arrive" is otherwise unanswerable.
    const detail = await res.text();
    throw new Error(`resend ${res.status}: ${detail.slice(0, 300)}`);
  }

  log.info({ to: job.to, subject: job.subject }, 'mail sent');
}
