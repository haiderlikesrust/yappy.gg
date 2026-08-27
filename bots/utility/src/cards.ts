import { EmbedBuilder, type MessageEntity } from '@yappydotgg/bot-sdk';

/** yappy's violet. One accent, used everywhere, so the bot reads as one thing. */
export const ACCENT = '#8b7cff';

/** A card in the house style. */
export function card(title: string): EmbedBuilder {
  return new EmbedBuilder().title(title).color(ACCENT);
}

/**
 * "@rayyan your pizza is ready", where the @rayyan actually notifies rayyan.
 *
 * Writing the handle as plain text looks identical and pings nobody, which for
 * a reminder is the entire job failing quietly. The offset is in UTF-16 code
 * units — the same thing `String#length` counts — and the mention is built at
 * the front where its length is known, rather than searched for afterwards.
 */
export function withMention(
  userId: string,
  label: string,
  rest: string,
): { content: string; entities: MessageEntity[] } {
  const handle = `@${label}`;
  return {
    content: `${handle} ${rest}`,
    entities: [{ type: 'mention', offset: 0, length: handle.length, userId }],
  };
}

/** What to call someone, in order of what they would recognise. */
export function nameOf(sender: { displayName?: string | null; username?: string | null } | null | undefined): string {
  return sender?.username ?? sender?.displayName ?? 'you';
}
