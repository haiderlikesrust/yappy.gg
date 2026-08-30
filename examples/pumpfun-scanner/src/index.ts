import { YappyBot, type InteractionResponse } from '@yappydotgg/bot-sdk';
import { scanCard } from './card.js';
import { fetchCoin, findMints } from './pumpfun.js';

/**
 * A pump.fun scanner for yappy.
 *
 * Paste a contract address into any group this bot is in and it replies with a
 * card: market cap, ATH, a bar of now-vs-ATH, age, whether it has bonded, and
 * a Refresh button. The card rewrites itself every thirty seconds for ten
 * minutes, then Refresh is how you ask again.
 *
 *   YAPPY_TOKEN        the bot token, shown once when you create the bot
 *   YAPPY_API_URL      optional, defaults to production
 *   YAPPY_GATEWAY_URL  optional, defaults to production
 *
 * Run it: `YAPPY_TOKEN=yb_… pnpm start`. That is the whole setup. The bot dials
 * out and holds the connection open, so this works on a laptop behind NAT with
 * no public address, no certificate and no tunnel — and there is no webhook to
 * configure or secret to keep.
 *
 * Add it to a group from group settings and paste an address.
 */

const token = requireEnv('YAPPY_TOKEN');
const bot = new YappyBot({ token, baseUrl: process.env.YAPPY_API_URL });

/**
 * Addresses already answered, so a group re-pasting the same one does not get
 * the same card five times.
 *
 * Keyed by conversation *and* mint: the same token being discussed in two
 * groups is two conversations that each deserve an answer. Ten minutes is long
 * enough to cover a thread about one coin and short enough that checking back
 * later still works.
 */
const recent = new Map<string, number>();
const DEDUPE_MS = 10 * 60 * 1000;

function seenRecently(conversationId: string, mint: string): boolean {
  const key = `${conversationId}:${mint}`;
  const at = recent.get(key);
  const now = Date.now();

  if (at && now - at < DEDUPE_MS) return true;
  recent.set(key, now);

  // Bounded, because this process is meant to run for weeks. Sweeping on write
  // avoids needing a timer.
  if (recent.size > 5_000) {
    for (const [k, t] of recent) if (now - t > DEDUPE_MS) recent.delete(k);
  }
  return false;
}

bot.connect({
  url: process.env.YAPPY_GATEWAY_URL,

  onReady: () => console.log('[scanner] connected'),
  onDisconnect: ({ code, willRetry }) =>
    console.log(`[scanner] disconnected (${code})${willRetry ? ', reconnecting' : ''}`),

  async onMessage({ conversationId, message }) {
    // The server already excludes the sending bot from its own events, so
    // there is no echo loop to guard against here.
    const text = message.content;
    if (!text) return;

    // At most two per message. Someone pasting a wall of addresses should not
    // turn into a wall of cards.
    for (const mint of findMints(text).slice(0, 2)) {
      if (seenRecently(conversationId, mint)) continue;

      const coin = await fetchCoin(mint);
      // Not a pump.fun coin. Almost every string that passes the regex lands
      // here, and that is fine: staying quiet is the correct answer.
      if (!coin) continue;

      // The lookup we just did is the first card. `live()` would otherwise
      // fetch again before posting, which is a wasted round-trip on the
      // path that already decided this mint is worth answering.
      let primed: typeof coin | null = coin;

      // First post notifies (this is the reply they asked for). Every
      // rewrite after that is silent — edits never push a phone. Ten
      // minutes matches the paste-dedupe window: after that, Refresh
      // still works, and a new paste starts a new live.
      await bot.live(conversationId, {
        every: '30s',
        until: '10m',
        silent: false,
        replyToId: message.id,
        // Idempotency. The platform retries a delivery it thinks failed, and
        // without this a retry posts the card twice. Tied to the message and
        // the mint so it is stable across those retries.
        //
        // Only the head of the mint: a nonce is capped at 64 characters, and
        // the whole address plus a message id is 86. The first eight base58
        // characters distinguish any two mints that could plausibly appear in
        // the same message, which is all this needs to do.
        nonce: `scan_${message.id}_${mint.slice(0, 8)}`,
        render: async () => {
          const latest = primed ?? (await fetchCoin(mint));
          primed = null;
          return latest ? scanCard(latest) : null;
        },
        onError: (err) => console.error('[scanner] live', err),
      });
    }
  },

  async onInteraction({ conversationId, customId }): Promise<InteractionResponse> {
    const [action, mint] = customId.split(':');
    if (!mint) return { kind: 'ack' };

    if (action === 'refresh') {
      const coin = await fetchCoin(mint);
      if (!coin) return { kind: 'ack' };
      const { embeds, components } = scanCard(coin);
      // `update` rewrites the card that was pressed, so Refresh feels like a
      // refresh rather than a second card underneath the first.
      return { kind: 'update', content: null, embeds, components };
    }

    if (action === 'ca') {
      // A bare address in its own message: long-pressable, selectable, and
      // nothing else in the way of copying it.
      return { kind: 'reply', content: mint, embeds: [], components: [] };
    }

    return { kind: 'ack' };
  },

  onError: (err) => console.error('[scanner]', err),
});

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}. See the README.`);
    process.exit(1);
  }
  return value;
}
