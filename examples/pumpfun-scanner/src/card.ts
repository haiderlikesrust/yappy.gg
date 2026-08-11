import { EmbedBuilder, button, row, type ComponentRow, type Embed } from '@yappy/bot-sdk';
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
    .field('ATH', `${coin.ath_market_cap.toFixed(1)} SOL`, true)
    .field('Age', age(coin.created_timestamp), true)
    .field('Replies', String(coin.reply_count ?? 0), true)
    .field('Status', coin.complete ? 'Bonded' : 'On curve', true)
    .field('Creator', shortMint(coin.creator), true)
    .field('Contract', coin.mint, false)
    .footer(coin.is_banned ? 'Banned on pump.fun' : 'Not financial advice')
    .timestamp();

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
