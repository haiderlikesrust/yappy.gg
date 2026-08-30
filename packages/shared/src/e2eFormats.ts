/**
 * Which message format two devices use to talk to each other.
 *
 * A sealed message is written in a format, and a device that does not know
 * that format cannot read it. Today there is exactly one — `yr.v2`, the double
 * ratchet — so every device agrees by accident. That stops being true the
 * first time a format changes: someone is on an older build, someone has been
 * offline for a month, one platform's release lands a week after another's.
 *
 * Without a way to ask, a sender guesses. Guessing wrong is not a retryable
 * error — the ratchet destroys keys as it uses them, so a message nobody could
 * read is a message that is gone. So each device *advertises* what it can
 * speak, and a sender picks the newest format both ends know.
 *
 * This file is the one place the rule is written. The web client imports it;
 * Android and iOS mirror it, and the mirrors say so. Every byte that is signed
 * has to be identical on all three, which is why the advertisement string is
 * spelled out here rather than assembled from whatever each platform finds
 * convenient.
 *
 * ## Why the advertisement is signed
 *
 * The server hands out these lists. A server that wanted everyone on the
 * weakest format it could name would only have to lie — say a device speaks
 * nothing but the oldest thing, and watch every sender obligingly downgrade.
 * That is a downgrade attack, and it is the reason capability negotiation is a
 * security mechanism rather than a convenience.
 *
 * So a device signs its own advertisement with its identity key — the same key
 * its messages are signed with and the same key the safety number is computed
 * from. The server can withhold the advertisement, and it can corrupt it; it
 * cannot forge one. A sender that cannot verify an advertisement falls back to
 * [OLDEST_MESSAGE_FORMAT] rather than trusting the server's word, which is the
 * one case where a downgrade is still possible and the reason that constant
 * should rise as soon as it safely can.
 */

/**
 * Every format this build can read and write.
 *
 * Ordered oldest to newest. Adding one means: implement it, add it here, and
 * leave the old one readable for as long as devices that only speak it may
 * still be sending.
 */
export const MESSAGE_FORMATS = [2] as const;

export type MessageFormat = (typeof MESSAGE_FORMATS)[number];

/** The newest this build knows, which is what it advertises as its ceiling. */
export const NEWEST_MESSAGE_FORMAT = MESSAGE_FORMATS[MESSAGE_FORMATS.length - 1]!;

/**
 * What to assume about a device that has published no advertisement.
 *
 * Every device in the directory today published from a build that speaks
 * exactly this, so the assumption is currently the truth rather than a guess.
 * It stays correct as long as this is the oldest format still in circulation —
 * which is the thing to check before retiring one.
 */
export const OLDEST_MESSAGE_FORMAT = MESSAGE_FORMATS[0]!;

/**
 * The bytes a device signs to prove which formats it speaks.
 *
 * Sorted and comma-joined, so the same set is the same string everywhere and
 * two devices cannot produce different signatures for the same claim. Only
 * digits and commas follow the prefix, so nothing here needs escaping.
 */
export function formatsAdvertisement(versions: readonly number[]): string {
  return `yappy.formats.v1:${[...new Set(versions)].sort((a, b) => a - b).join(',')}`;
}

/**
 * The newest format both ends can read, or null when there is no overlap.
 *
 * Null is a real answer: a device too old to understand anything this one can
 * write gets no copy of the message. The caller shows that honestly rather
 * than sending something that will arrive as an unreadable blob.
 */
export function chooseFormat(
  mine: readonly number[],
  theirs: readonly number[],
): number | null {
  const shared = mine.filter((v) => theirs.includes(v));
  return shared.length > 0 ? Math.max(...shared) : null;
}

/** Parse an advertisement as stored: "2" or "2,3". Junk reads as nothing. */
export function parseFormats(stored: string | null | undefined): number[] {
  if (!stored) return [];
  return stored
    .split(',')
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0 && n < 1000);
}
