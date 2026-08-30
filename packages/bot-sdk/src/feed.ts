import { parseDuration } from './live.js';
import type { BotCard, Feed, FeedOptions } from './types.js';

/** The one call a feed needs. Structural so this file does not import the client. */
export interface FeedBot {
  card(conversationId: string, key: string): BotCard;
}

/**
 * The same floor as `live()`: ten seconds.
 *
 * Not a politeness limit — every write costs a `message.send` token, and a
 * feed is meant to outlive the process that started it. A one-second loop
 * spends the whole budget inside a minute and takes the bot's ordinary replies
 * down with it.
 */
const MIN_EVERY_MS = 10_000;

/** Longest a failing feed waits between attempts. */
const MAX_BACKOFF_MS = 5 * 60_000;

/**
 * Errors that mean "stop", not "try again".
 *
 * The channel was deleted, or the bot was removed from it, or its permission
 * to post was taken away. None of those come back on their own, and a loop
 * that keeps asking is a loop somebody has to go and find in a log.
 */
function isGone(err: unknown): boolean {
  const status = (err as { status?: number } | undefined)?.status;
  return status === 403 || status === 404;
}

/**
 * Keep a named card current, for as long as this process runs.
 *
 * A loop over `card().set()` and nothing more. What makes it worth a helper is
 * what it deliberately does *not* hold: no message id, so a restart, a
 * redeploy or a second replica writes to the same card rather than posting
 * another one beside it.
 */
export async function startFeed(
  bot: FeedBot,
  conversationId: string,
  key: string,
  options: FeedOptions,
  onStop?: () => void,
): Promise<Feed> {
  const everyMs = Math.max(MIN_EVERY_MS, parseDuration(options.every ?? '30s', 'every'));
  const silent = options.silent ?? true;
  const card = bot.card(conversationId, key);

  let running = true;
  let ticking = false;
  let messageId: string | null = null;
  let failures = 0;
  let nextAttemptAt = 0;
  let interval: ReturnType<typeof setInterval> | null = null;

  const stop = () => {
    if (!running) return;
    running = false;
    if (interval) clearInterval(interval);
    interval = null;
    onStop?.();
  };

  /**
   * @param forced A manual `refresh()`, or the first write. Ignores an active
   * backoff: the caller is asking now, and making them wait out a penalty they
   * did not incur would be its own surprise.
   */
  const tick = async (forced: boolean): Promise<void> => {
    if (!running || ticking) return;
    if (!forced && Date.now() < nextAttemptAt) return;
    ticking = true;
    try {
      const next = await options.render();
      if (!running || !next) return;
      const result = await card.set({ ...next, silent });
      messageId = result.message.id;
      failures = 0;
      nextAttemptAt = 0;
    } catch (err) {
      if (isGone(err)) {
        options.onError?.(err);
        stop();
        throw err;
      }
      /*
       * Back off rather than hammer. A feed's upstream is somebody else's API,
       * and the failure that matters is the one that lasts an hour: at a
       * ten-second cadence that is 360 attempts, 360 log lines, and 360
       * requests aimed at whoever is already having a bad day.
       */
      failures += 1;
      nextAttemptAt = Date.now() + Math.min(MAX_BACKOFF_MS, everyMs * 2 ** failures);
      options.onError?.(err);
      throw err;
    } finally {
      ticking = false;
    }
  };

  const feed: Feed = {
    conversationId,
    key,
    get messageId() {
      return messageId;
    },
    get running() {
      return running;
    },
    stop,
    async refresh() {
      await tick(true).catch(() => {});
    },
  };

  /*
   * The first write is awaited, and its failure is the caller's.
   *
   * A bad token, a channel the bot cannot post in, or a `render()` that throws
   * on its very first call should surface where somebody is looking — at the
   * line that started the feed — rather than as a board that silently stays
   * empty. Every tick after this one is the loop's problem, not the caller's:
   * one bad lookup must not end a feed that would have recovered.
   */
  try {
    await tick(true);
  } catch (err) {
    stop();
    throw err;
  }

  // Ordinary (referenced) timer: publishing the card *is* this process's work,
  // so a program whose only job is a feed should stay alive. `stop()` is how it
  // ends.
  if (running) interval = setInterval(() => void tick(false).catch(() => {}), everyMs);
  return feed;
}
