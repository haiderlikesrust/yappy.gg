import type {
  InteractionPressedEvent,
  InteractionResponse,
  MessageCreatedEvent,
  WebhookEvent,
} from './types.js';
import type { YappyBot } from './client.js';
import { verifySignature } from './verify.js';

export interface HandlerOptions {
  /** The webhook secret, shown once when you set the webhook. */
  secret: string;
  /**
   * Required if you handle interactions.
   *
   * A press is answered by a call back to the API, not by the body of this
   * response — see the note on `onInteraction`. Without a client to make that
   * call, anything you return from the handler has nowhere to go.
   */
  bot?: Pick<YappyBot, 'respondToInteraction'>;
  onMessage?: (event: MessageCreatedEvent['data']) => void | Promise<void>;
  /**
   * Return an {@link InteractionResponse} to change the card that was pressed.
   * Returning nothing is the same as `{ kind: 'ack' }`.
   *
   * Requires `bot`: the response is applied by calling the API back, because
   * the server does not read this webhook's response body. It never did — the
   * delivery only checks the status code — so a bot that returned an `update`
   * here and set no client watched its Refresh button do nothing at all.
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
    rawBody: string | Uint8Array,
    signature: string | undefined | null,
  ): Promise<HandlerResult> {
    if (!verifySignature(rawBody, signature, options.secret)) {
      return { status: 401, body: JSON.stringify({ ok: false, error: 'bad_signature' }) };
    }

    let event: WebhookEvent;
    try {
      // `TextDecoder`, not `Buffer#toString('utf8')`: the parameter admits any
      // Uint8Array, and a plain one would have stringified to "123,34,…".
      event = JSON.parse(typeof rawBody === 'string' ? rawBody : new TextDecoder().decode(rawBody));
    } catch (err) {
      options.onError?.(err);
      return { status: 400, body: JSON.stringify({ ok: false, error: 'bad_json' }) };
    }

    /**
     * An interaction, answered by calling back rather than by replying.
     *
     * This used to return the response as the body and describe that as the
     * mechanism. It is not: `deliverBotEvent` checks the status code and
     * throws the body away, so every `update` returned from a webhook handler
     * was silently discarded and the pressed card never changed. The press is
     * applied by a call to the API, which is also what a socket bot does —
     * one behaviour, whichever transport delivered the press.
     *
     * Still answered fast. The 200 goes back before the handler runs, because
     * the platform allows five seconds and counts a slow reply as a failed
     * delivery worth retrying.
     */
    if (event.type === 'interaction.pressed') {
      const press = event.data;
      void Promise.resolve()
        .then(async () => {
          const response = await options.onInteraction?.(press);
          if (!response || response.kind === 'ack') return;
          if (!options.bot) {
            throw new Error(
              'onInteraction returned a response but no `bot` was given to createHandler — ' +
                'the press cannot be answered without one',
            );
          }
          await options.bot.respondToInteraction(press.conversationId, press.messageId, response);
        })
        .catch((err: unknown) => options.onError?.(err, event));

      return { status: 200, body: JSON.stringify({ ok: true }) };
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
