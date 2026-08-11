import type {
  InteractionPressedEvent,
  InteractionResponse,
  MessageCreatedEvent,
  WebhookEvent,
} from './types.js';
import { verifySignature } from './verify.js';

export interface HandlerOptions {
  /** The webhook secret, shown once when you set the webhook. */
  secret: string;
  onMessage?: (event: MessageCreatedEvent['data']) => void | Promise<void>;
  /**
   * Return an {@link InteractionResponse} to change the card that was pressed.
   * Returning nothing is the same as `{ kind: 'ack' }`.
   */
  onInteraction?: (
    event: InteractionPressedEvent['data'],
  ) => InteractionResponse | void | Promise<InteractionResponse | void>;
  /** Anything thrown by your handlers lands here rather than crashing the process. */
  onError?: (err: unknown, event?: WebhookEvent) => void;
}

export interface HandlerResult {
  status: number;
  body: string;
}

/**
 * Turn webhook deliveries into calls to your handlers.
 *
 * Framework-agnostic: it takes the raw body and the signature header and hands
 * back a status and a body, so it drops into Express, Fastify, a Cloudflare
 * Worker, or `node:http` without adapters.
 *
 * Two things it does that are easy to get wrong on your own.
 *
 * **It answers fast.** Your handler runs *after* the 200 is returned, not
 * before. The platform allows five seconds and counts a slow reply as a failed
 * delivery, then retries with backoff — so a bot that does thirty seconds of
 * work inline gets retried while it is still working, and processes the same
 * event several times. Do the work in the background and post the result when
 * it is ready.
 *
 * **It never trusts an unverified body.** A bad signature is a 401 and your
 * handlers are not called at all.
 */
export function createHandler(options: HandlerOptions) {
  return async function handle(
    rawBody: string | Buffer,
    signature: string | undefined | null,
  ): Promise<HandlerResult> {
    if (!verifySignature(rawBody, signature, options.secret)) {
      return { status: 401, body: JSON.stringify({ ok: false, error: 'bad_signature' }) };
    }

    let event: WebhookEvent;
    try {
      event = JSON.parse(typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8'));
    } catch (err) {
      options.onError?.(err);
      return { status: 400, body: JSON.stringify({ ok: false, error: 'bad_json' }) };
    }

    // An interaction is the one case where the answer *is* the response body,
    // so it cannot be deferred: the platform applies what you return to the
    // card that was pressed. Keep it quick, and if the real work is slow,
    // acknowledge here and edit the message afterwards.
    if (event.type === 'interaction.pressed') {
      try {
        const response = (await options.onInteraction?.(event.data)) ?? { kind: 'ack' as const };
        return { status: 200, body: JSON.stringify(response) };
      } catch (err) {
        options.onError?.(err, event);
        return { status: 200, body: JSON.stringify({ kind: 'ack' }) };
      }
    }

    if (event.type === 'message.created') {
      // Deliberately not awaited. See the note above about the five-second
      // budget: answering first is what stops a slow handler turning into a
      // retry storm of duplicate work.
      void Promise.resolve()
        .then(() => options.onMessage?.(event.data))
        .catch((err: unknown) => options.onError?.(err, event));
    }

    return { status: 200, body: JSON.stringify({ ok: true }) };
  };
}
