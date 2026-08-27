import { EmbedBuilder, button, row, type ComponentRow, type Embed } from '@yappydotgg/bot-sdk';
import { age, shortMint, usd, type Coin } from './pumpfun.js';

const VIOLET = '#8b7cff';
const GREEN = '#3dd68c';
const AMBER = '#f5a524';

/**
 * The scan card.
 *
 * **Built from fields, not from one long description.** This is the single
 * most important thing to copy out of this example. Clients cap an embed's
 * description at eight lines and ellipsise the rest, so a stats block written
 * as one paragraph gets cut in half on a phone — and the half that survives is
 * the half you cared least about. Fields are not capped, they lay out two-up,
 * and they stay readable when a number gets long.
 *
 * The description is used for exactly one thing: the token's own blurb, which
 * is prose and belongs in prose.
 */
export function scanCard(coin: Coin): { embeds: Embed[]; components: ComponentRow[] } {
  const flagged = coin.is_banned || coin.nsfw;

  const card = new EmbedBuilder()
    .title(`${coin.name?.trim() || 'Unknown'} — ${coin.symbol}`)
    .url(`https://pump.fun/coin/${coin.mint}`)
    .color(coin.is_banned ? AMBER : coin.complete ? GREEN : VIOLET)
    .author('pump.fun')
    .field('Market cap', usd(coin.usd_market_cap), true)
    .field('ATH', athUsd(coin), true)
    .field('Age', age(coin.created_timestamp), true)
    .field('Replies', String(coin.reply_count ?? 0), true)
    .field('Status', coin.complete ? 'Bonded' : 'On curve', true)
    .field('Creator', shortMint(coin.creator), true)
    .field('Contract', coin.mint, false)
    .footer(coin.is_banned ? 'Banned on pump.fun' : 'Not financial advice')
    .timestamp();

  /**
   * Same two numbers as the fields above, drawn. A client that has never
   * heard of charts still has the fields; one that has gets the bar. ATH
   * in SOL next to a dollar market cap would draw a lie, so the rate is
   * the same conversion `athUsd` uses.
   */
  const ath = athUsdValue(coin);
  if (ath && coin.usd_market_cap > 0) {
    card.chart('bar', [
      { label: 'Now', value: coin.usd_market_cap },
      { label: 'ATH', value: ath },
    ]);
  }

  // The token's own text, and only if it is short. A long one would eat the
  // eight-line budget the fields are here to avoid using.
  const blurb = coin.description?.trim();
  if (!flagged && blurb && blurb.length <= 180) card.description(blurb);

  /**
   * No image for a flagged token.
   *
   * pump.fun lets anyone mint anything, and `nsfw` and `is_banned` exist
   * because some of it is exactly what you would expect. A scanner that
   * renders every image it is handed will eventually paste something into
   * somebody's group chat that they did not ask for and cannot un-see. The
   * stats are still useful, so the card still posts; the picture does not.
   */
  if (!flagged && coin.image_uri) card.thumbnail(coin.image_uri);

  const buttons = [
    button(`refresh:${coin.mint}`, 'Refresh', 'primary'),
    button(`ca:${coin.mint}`, 'Send CA'),
  ];

  return { embeds: [card.build()], components: [row(...buttons)] };
}

/**
 * The all-time high, in the same currency as the number above it.
 *
 * `ath_market_cap` is denominated in SOL, `usd_market_cap` in dollars. Printing
 * them side by side as "$2.1K" and "22502.5 SOL" reads as a token that is down
 * four orders of magnitude, when the real answer is that one is a different
 * unit. The rate is taken from the pair the response already carries, so no
 * price feed is involved; if `market_cap` is zero there is nothing to divide
 * by and the SOL figure is labelled as such rather than guessed at.
 */
function athUsdValue(coin: Coin): number | null {
  if (!coin.ath_market_cap) return null;
  const solToUsd = coin.market_cap > 0 ? coin.usd_market_cap / coin.market_cap : 0;
  return solToUsd > 0 ? coin.ath_market_cap * solToUsd : null;
}

function athUsd(coin: Coin): string {
  const value = athUsdValue(coin);
  return value !== null ? usd(value) : coin.ath_market_cap ? `${coin.ath_market_cap.toFixed(1)} SOL` : '—';
}
