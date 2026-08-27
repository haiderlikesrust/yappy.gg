import { newNonce } from './nonce.js';
import type { IncomingMessage, LiveCard, LiveDuration, LiveOptions, RenderedCard, SendMessageInput } from './types.js';

/** The two calls a live card needs. Kept structural so this file does not import the client. */
export interface LiveBot {
  send(conversationId: string, input: SendMessageInput): Promise<{ message: IncomingMessage }>;
  edit(conversationId: string, messageId: string, input: RenderedCard): Promise<unknown>;
}

const UNIT = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** Floored so a `every: '1s'` loop cannot chew the messaging rate limit. */
const MIN_EVERY_MS = 10_000;
/** A forgotten live must not run until the process dies. */
const MAX_UNTIL_MS = 24 * 60 * 60 * 1_000;

export function parseDuration(value: LiveDuration, label: string): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${label} must be a positive number of milliseconds`);
    }
    return value;
  }
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(String(value).trim());
  if (!match) {
    throw new Error(`Unrecognised ${label} "${value}". Use 30s, 5m, 1h, or a number of milliseconds.`);
  }
  const ms = Number(match[1]) * UNIT[match[2] as keyof typeof UNIT];
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(`${label} "${value}" is not positive`);
  }
  return ms;
}

function isGone(err: unknown): boolean {
  const status = (err as { status?: number } | undefined)?.status;
  return status === 404 || status === 403;
}

const nonce = () => newNonce('live');

/**
 * Post a card, then rewrite it on a timer.
 *
 * This is a client-side loop over `send` and `edit`. There is no server
 * subscription: a webhook bot with no process to keep alive cannot use it,
 * and a process that exits stops the rewriting. The card itself stays.
 */
export async function startLive(
  bot: LiveBot,
  conversationId: string,
  options: LiveOptions,
  onStop?: () => void,
): Promise<LiveCard> {
  const everyMs = Math.max(MIN_EVERY_MS, parseDuration(options.every ?? '30s', 'every'));
  const untilMs = Math.min(MAX_UNTIL_MS, parseDuration(options.until ?? '1h', 'until'));
  const silent = options.silent ?? true;

  const first = await options.render();
  if (!first) {
    throw new Error('live() render() returned nothing on the first call — there is no card to post');
  }

  const posted = await bot.send(conversationId, {
    ...first,
    silent,
    replyToId: options.replyToId,
    nonce: options.nonce ?? nonce(),
  });

  const messageId = posted.message.id;
  let running = true;
  let ticking = false;
  let interval: ReturnType<typeof setInterval> | null = null;
  let deadline: ReturnType<typeof setTimeout> | null = null;

  const fail = (err: unknown) => options.onError?.(err);

  const apply = async (card: RenderedCard) => {
    await bot.edit(conversationId, messageId, card);
  };

  const tick = async () => {
    if (!running || ticking) return;
    ticking = true;
    try {
      const next = await options.render();
      if (!running || !next) return;
      await apply(next);
    } catch (err) {
      if (isGone(err)) {
        stop();
        return;
      }
      fail(err);
    } finally {
      ticking = false;
    }
  };

  const stop = () => {
    if (!running) return;
    running = false;
    if (interval) clearInterval(interval);
    if (deadline) clearTimeout(deadline);
    interval = null;
    deadline = null;
    onStop?.();
  };

  // The deadline is armed either way. With `until` shorter than `every` there
  // is never a tick, and without this the card would sit in the process
  // claiming to be running until something else stopped it.
  if (untilMs > everyMs) interval = setInterval(() => void tick(), everyMs);
  deadline = setTimeout(stop, untilMs);

  return {
    conversationId,
    messageId,
    get running() {
      return running;
    },
    stop,
    async refresh() {
      await tick();
    },
  };
}
