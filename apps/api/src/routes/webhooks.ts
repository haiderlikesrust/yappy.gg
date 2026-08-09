import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { env } from '../env.js';
import { renderGitHubEvent } from '../lib/gitlog.js';

/**
 * Inbound webhooks from services we run ourselves.
 *
 * Distinct from `lib/webhooks.ts`, which is the *outbound* half — deliveries to
 * bots people wrote. This is the other direction, and it is the only
 * unauthenticated write path in the API that posts a message.
 *
 * That fact is what shapes everything below. There is no session, no user and
 * no `req.user`; the signature is the entire authorisation, and the account the
 * message is posted as (yapper) is chosen here rather than derived from the
 * request. So the checks are ordered to refuse as early and as cheaply as
 * possible, and a request that fails any of them produces no message, no queue
 * job and no log line an attacker can use to tell the failures apart.
 */

/**
 * GitHub signs the exact bytes it sent, so verification has to run against the
 * raw string rather than a re-serialised object — key order, whitespace and
 * unicode escaping all survive `JSON.parse` → `JSON.stringify` only by luck.
 * `app.ts` stashes the raw body for this prefix and nowhere else.
 */
declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
}

/**
 * Constant-time compare of the delivered signature against ours.
 *
 * The length guard is not an optimisation — `timingSafeEqual` throws on
 * mismatched lengths, and an exception here would be a 500 where a 401 belongs.
 */
function signatureMatches(secret: string, raw: string, header: string): boolean {
  const expected = `sha256=${createHmac('sha256', secret).update(raw, 'utf8').digest('hex')}`;
  const a = Buffer.from(header, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GitHub → the staff #gitlog channel.
   *
   * Configure at Settings → Webhooks with content type `application/json`,
   * the secret in `GITHUB_WEBHOOK_SECRET`, and the events yapper knows how to
   * render: pushes, pull requests, releases, workflow runs, issues.
   *
   * Answers 202 for anything correctly signed, including events it chooses not
   * to post. GitHub does not retry a failed delivery automatically — it goes
   * red in the delivery list and waits for a human to press redeliver — so
   * "understood, said nothing" and "understood, posted" must look the same from
   * the outside. Only a bad signature and a missing configuration are errors.
   */
  app.post('/github', async (req, reply) => {
    if (!env.GITHUB_WEBHOOK_SECRET) {
      // Refuse rather than accept-and-drop. An endpoint that returns 202 while
      // silently discarding everything is how a channel stays quiet for a month
      // before anyone thinks to check whether it is configured.
      app.log.warn('github webhook received but GITHUB_WEBHOOK_SECRET is unset');
      return reply.status(503).send({ error: 'Webhooks are not configured' });
    }

    await app.limiter.consume(`ip:${req.ip}`, 'webhook.github');

    const signature = req.headers['x-hub-signature-256'];
    const raw = req.rawBody;

    if (typeof signature !== 'string' || typeof raw !== 'string') {
      return reply.status(401).send({ error: 'Unsigned' });
    }
    if (!signatureMatches(env.GITHUB_WEBHOOK_SECRET, raw, signature)) {
      // Deliberately not logging the delivered signature or the body: this is
      // the one path an unauthenticated caller controls, and a log full of
      // attacker-chosen strings is its own problem.
      app.log.warn({ ip: req.ip }, 'github webhook signature rejected');
      return reply.status(401).send({ error: 'Bad signature' });
    }

    const event = String(req.headers['x-github-event'] ?? '');
    const delivery = String(req.headers['x-github-delivery'] ?? '');

    // GitHub's handshake, sent once when the hook is saved. Answering it is
    // what turns the tick green in the UI.
    if (event === 'ping') return reply.send({ ok: true, pong: true });

    const card = renderGitHubEvent(event, req.body);
    if (!card) return reply.status(202).send({ ok: true, posted: false });

    /**
     * Enqueued rather than posted inline.
     *
     * Two reasons, and the second is the real one. GitHub gives a delivery ten
     * seconds, which posting comfortably fits inside — but a transient database
     * hiccup during those ten seconds would lose the event permanently, because
     * GitHub does not retry. pg-boss does, five times with backoff.
     *
     * The delivery id is what makes those retries safe: it is stable across
     * GitHub's own redelivery button too, so pressing it produces the same
     * message rather than a second copy. 50 characters, inside the 64 the nonce
     * column allows.
     */
    await app.enqueue('yapper.staff', {
      kind: 'gitlog',
      dedupe: delivery || `${event}_${Date.now()}`,
      payload: { content: card.content, embeds: card.embeds },
    });

    return reply.status(202).send({ ok: true, posted: true });
  });
}
