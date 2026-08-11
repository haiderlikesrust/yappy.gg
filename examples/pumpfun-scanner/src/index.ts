import { createServer } from 'node:http';
import { YappyBot, createHandler, type InteractionResponse } from '@yappy/bot-sdk';
import { scanCard } from './card.js';
import { fetchCoin, findMints } from './pumpfun.js';

/**
 * A pump.fun scanner for yappy.
 *
 * Paste a contract address into any group this bot is in and it replies with a
 * card: market cap, ATH, age, whether it has bonded, and a Refresh button.
 *
 *   YAPPY_TOKEN           the bot token, shown once when you create the bot
 *   YAPPY_WEBHOOK_SECRET  shown once when you set the webhook URL
 *   YAPPY_API_URL         optional, defaults to production
 *   PORT                  optional, defaults to 8787
 *
 * Point the bot's webhook at `https://your-host/yappy` and add it to a group
 * from group settings. Nothing here is yappy-specific plumbing you have to
 * understand: the SDK verifies signatures, answers inside the five-second
 * budget, and hands you the parsed event.
 */

const token = requireEnv('YAPPY_TOKEN');
const secret = requireEnv('YAPPY_WEBHOOK_SECRET');
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

const handle = createHandler({
  secret,

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

      const { embeds, components } = scanCard(coin);
      await bot.reply(conversationId, message.id, {
        embeds,
        components,
        // Idempotency. The platform retries a delivery it thinks failed, and
        // without this a retry posts the card twice. Tied to the message and
        // the mint so it is stable across those retries.
        //
        // Only the head of the mint: a nonce is capped at 64 characters, and
        // the whole address plus a message id is 86. The first eight base58
        // characters distinguish any two mints that could plausibly appear in
        // the same message, which is all this needs to do.
        nonce: `scan_${message.id}_${mint.slice(0, 8)}`,
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

createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }

  // The raw body, not a parsed one. The signature is over the exact bytes that
  // were sent, so re-encoding a parsed object fails to verify for reasons that
  // look like a wrong secret.
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    void (async () => {
      const raw = Buffer.concat(chunks);
      const signature = req.headers['x-yappy-signature'];
      const result = await handle(raw, Array.isArray(signature) ? signature[0] : signature);
      res.writeHead(result.status, { 'content-type': 'application/json' }).end(result.body);
    })();
  });
}).listen(Number(process.env.PORT ?? 8787), () => {
  console.log(`[scanner] listening on ${process.env.PORT ?? 8787}`);
});

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}. See the README.`);
    process.exit(1);
  }
  return value;
}
