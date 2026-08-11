/**
 * The pump.fun side of the scanner.
 *
 * Kept separate from the bot so the parts that talk to yappy have nothing to
 * say about token data, and this file can be swapped for a different chain or a
 * different provider without touching the bot at all.
 */

/** The subset of the response worth rendering. There is a lot more. */
export interface Coin {
  mint: string;
  name: string;
  symbol: string;
  description: string | null;
  image_uri: string | null;
  twitter: string | null;
  website: string | null;
  creator: string;
  created_timestamp: number;
  /** True once it has graduated off the bonding curve. */
  complete: boolean;
  /** In SOL. `usd_market_cap` is the one people mean. */
  market_cap: number;
  usd_market_cap: number;
  ath_market_cap: number;
  reply_count: number;
  last_trade_timestamp: number | null;
  nsfw: boolean;
  is_banned: boolean;
}

const API = 'https://frontend-api-v3.pump.fun/coins';

/**
 * Solana mint addresses: base58, 32 to 44 characters.
 *
 * base58 excludes `0`, `O`, `I` and `l` precisely so addresses cannot be
 * misread, which also makes this a tighter filter than it looks.
 *
 * Deliberately not requiring the `pump` suffix. Most pump.fun mints end in it
 * and it would cut false positives to near zero, but a token that migrated or
 * was created another way would then be silently ignored — and silence is the
 * worst failure mode for a scanner. The lookup returning 404 is the real
 * filter; this only decides what is worth one HTTP call.
 */
const MINT = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;

export function findMints(text: string): string[] {
  const found = text.match(MINT) ?? [];
  // An all-lowercase run of letters is a word, not an address. Real base58
  // keys mix case and digits, so this drops the obvious false positives before
  // they cost a request.
  const plausible = found.filter((m) => /[A-Z]/.test(m) && /[0-9]/.test(m));
  return [...new Set(plausible)];
}

/**
 * Look up one mint.
 *
 * Returns null for anything that is not a coin — a 404 is the expected
 * outcome for most strings that pass the regex, not an error worth logging.
 */
export async function fetchCoin(mint: string): Promise<Coin | null> {
  try {
    const res = await fetch(`${API}/${mint}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as Coin;
  } catch {
    // A timeout or a DNS blip is not worth crashing a bot over. The next
    // person to paste the address gets another go.
    return null;
  }
}

// ── Formatting ───────────────────────────────────────────────────────────────

export function usd(value: number): string {
  if (!Number.isFinite(value)) return '?';
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(2)}`;
}

export function age(createdMs: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - createdMs) / 1000));
  const days = Math.floor(seconds / 86_400);
  if (days >= 1) return `${days}d`;
  const hours = Math.floor(seconds / 3_600);
  if (hours >= 1) return `${hours}h`;
  return `${Math.max(1, Math.floor(seconds / 60))}m`;
}

/** `7k8d4b…npump` — enough to recognise, short enough to sit in a field. */
export function shortMint(mint: string): string {
  return mint.length > 12 ? `${mint.slice(0, 6)}…${mint.slice(-6)}` : mint;
}
