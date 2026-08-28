import { createTransport, type Transporter } from 'nodemailer';
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
 *
 * Three providers:
 *
 *   • `console` prints the letter. This *is* the inbox in development, and it
 *     beats a real one when you are testing the tenth signup of the morning.
 *   • `smtp` speaks to an ordinary mailbox — Hostinger, Fastmail, a company
 *     server. Almost every domain already has one, which makes it the option
 *     that needs no new account anywhere.
 *   • `resend` posts one JSON body at an HTTP API, for anyone who would rather
 *     not put a mailbox password in an environment variable.
 *
 * Why a library for SMTP when APNs next door is hand-rolled: APNs is one POST
 * over h2. SMTP is a stateful conversation with a TLS upgrade, several auth
 * mechanisms, line-ending rules and dot-stuffing, and the way it fails is
 * "your password reset never arrived". That is the wrong place to be clever.
 */

export interface EmailJob {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * One pooled connection for the process, built on first use.
 *
 * Mailbox providers are far happier with a connection that is reused than with
 * a fresh TLS handshake and login per message, and several of them count logins
 * against an hourly limit.
 */
let transporter: Transporter | null = null;

function smtp(): Transporter {
  transporter ??= createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    // 465 is TLS from the first byte; 587 starts plain and upgrades with
    // STARTTLS. Both are fine, and getting this backwards is the single most
    // common way an SMTP config hangs rather than failing.
    secure: env.SMTP_SECURE,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
    pool: true,
    maxConnections: 2,
    // A queue job that hangs is worse than one that fails: the failure retries.
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return transporter;
}

/**
 * Check the credentials at boot rather than at the moment somebody is locked
 * out. Logs and returns; a mail server having a bad morning is not a reason for
 * the worker to refuse to process anything else.
 */
export async function verifyMailer(log: Logger): Promise<void> {
  if (env.EMAIL_PROVIDER !== 'smtp') return;
  try {
    await smtp().verify();
    log.info({ host: env.SMTP_HOST, from: env.EMAIL_FROM }, 'smtp ready');
  } catch (err) {
    log.error({ err, host: env.SMTP_HOST }, 'smtp is not usable — verification and reset mail will fail');
  }
}

export async function handleEmail(log: Logger, job: EmailJob): Promise<void> {
  if (!job.to) throw new Error('email job has no recipient');

  if (env.EMAIL_PROVIDER === 'console') {
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

  if (env.EMAIL_PROVIDER === 'smtp') {
    if (!env.SMTP_HOST || !env.SMTP_USER) {
      throw new Error('EMAIL_PROVIDER is smtp but SMTP_HOST or SMTP_USER is empty');
    }
    await smtp().sendMail({
      // Most mailbox providers refuse a From that is not the mailbox that
      // authenticated, so this defaults to the login rather than inventing an
      // address that will bounce.
      from: env.EMAIL_FROM || env.SMTP_USER,
      to: job.to,
      subject: job.subject,
      text: job.text,
      ...(job.html ? { html: job.html } : {}),
    });
    log.info({ to: job.to, subject: job.subject }, 'mail sent');
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
