/**
 * The wire shapes a bot deals in.
 *
 * Written out here rather than imported from `@yappy/shared` on purpose. This
 * package is the one thing in the repo a *third party* depends on, and pulling
 * in the server's internal schemas would mean every refactor of an unrelated
 * zod object was a breaking change for somebody's bot. These are a deliberate,
 * narrow copy of the contract, and the contract is what we promise not to
 * break.
 */

export interface EmbedField {
  name: string;
  value: string;
  /** Sit two side by side instead of stacking. */
  inline?: boolean;
}

export type ChartKind = 'line' | 'area' | 'bar' | 'pie' | 'donut' | 'scatter';

export interface ChartPoint {
  /** Capped at 16 characters on the wire. */
  label: string;
  value: number;
}

/**
 * An inline data chart. Additive: a client that has never heard of it
 * renders the embed's title, description and fields and loses nothing but
 * the picture. Bounded hard — 2 to 24 points (8 for pie/donut). Write the
 * same numbers as fields so the chart never carries information alone.
 */
export interface EmbedChart {
  kind: ChartKind;
  points: ChartPoint[];
}

export interface Embed {
  title?: string | null;
  description?: string | null;
  url?: string | null;
  /** `#RRGGBB`. The accent bar down the left edge. */
  color?: string | null;
  author?: { name: string; url?: string | null; iconUrl?: string | null } | null;
  fields?: EmbedField[];
  image?: { url: string } | null;
  thumbnail?: { url: string } | null;
  chart?: EmbedChart | null;
  footer?: { text: string; iconUrl?: string | null } | null;
  timestamp?: string | null;
}

export type ButtonStyle = 'primary' | 'secondary' | 'success' | 'danger';

export interface Button {
  type: 'button';
  /**
   * Your own identifier, echoed back when someone presses. Not a secret and it
   * confers nothing: authorisation is membership of the conversation plus, if
   * you set it, `onlyUserId`.
   */
  customId: string;
  label: string;
  style: ButtonStyle;
  disabled?: boolean;
  /** Only this person may press it. Everyone else sees it, greyed. */
  onlyUserId?: string | null;
  /**
   * Decimal permission bitfield the *presser* must hold. Enforced
   * server-side against the presser, never against the bot. `button()`
   * accepts a name (`'KICK_MEMBERS'`) and writes the decimal string for you.
   */
  requiredPermissions?: string | null;
}

export interface ComponentRow {
  type: 'row';
  /** Max 5. Long labels stack full width rather than being squeezed. */
  components: Button[];
}

/**
 * A span of `content` that means something.
 *
 * Offsets are into the string as JavaScript indexes it — UTF-16 code units, so
 * `"héllo".length`, not the number of characters a human would count. Get one
 * wrong and the span lands in the middle of a word rather than being rejected,
 * which is why a bot should build these while it builds the string rather than
 * measuring afterwards.
 *
 * A `mention` is the only way to actually notify somebody: writing "@rayyan"
 * as plain text is text. This matters most for the obvious bot job — answering
 * the person who asked for something.
 */
export type MessageEntity =
  | { type: 'mention'; offset: number; length: number; userId: string }
  | { type: 'mention_all'; offset: number; length: number }
  | { type: 'mention_role'; offset: number; length: number; roleId: string }
  /** A signpost to another channel; notifies nobody. */
  | { type: 'mention_channel'; offset: number; length: number; channelId: string }
  | { type: 'link'; offset: number; length: number; url: string }
  | { type: 'bold'; offset: number; length: number }
  | { type: 'italic'; offset: number; length: number }
  | { type: 'strike'; offset: number; length: number }
  | { type: 'spoiler'; offset: number; length: number }
  | { type: 'code'; offset: number; length: number }
  | { type: 'pre'; offset: number; length: number; language?: string | null };

export interface SendMessageInput {
  content?: string | null;
  /** Mentions, links and formatting over `content`. Max 200. */
  entities?: MessageEntity[];
  embeds?: Embed[];
  components?: ComponentRow[];
  replyToId?: string | null;
  /**
   * Deliver without pushing anyone's phone. Worth setting for anything a
   * machine emits at machine pace: a channel people mute is a channel that
   * swallows the one message that mattered.
   */
  silent?: boolean;
  /**
   * Idempotency key. Send the same nonce twice and you get the same message
   * back rather than two of them, which is what makes a retry safe.
   */
  nonce?: string;
}

/** The sender on an incoming message. Absent on system lines. */
export interface MessageSender {
  id: string;
  username?: string | null;
  displayName?: string | null;
  isBot?: boolean;
}

export interface IncomingMessage {
  id: string;
  conversationId: string;
  seq: number;
  type: string;
  content?: string | null;
  senderId?: string | null;
  sender?: MessageSender | null;
  createdAt?: string;
  [key: string]: unknown;
}

export interface MessageCreatedEvent {
  type: 'message.created';
  data: { conversationId: string; message: IncomingMessage };
  sentAt: string;
}

export interface InteractionPressedEvent {
  type: 'interaction.pressed';
  data: {
    conversationId: string;
    messageId: string;
    customId: string;
    /**
     * Who pressed, and what they are allowed to do here. Sent so a bot can
     * decide without a follow-up call, and therefore has no excuse not to
     * check before acting on a destructive button.
     */
    invoker: { userId: string; permissions: string; isStaff: boolean };
  };
  sentAt: string;
}

export type WebhookEvent = MessageCreatedEvent | InteractionPressedEvent;

/**
 * What a bot may return from an interaction handler.
 *
 * `update` rewrites the card that was pressed, which is what a spent prompt
 * should become. `reply` posts a new message. `ack` does nothing visible and is
 * the right answer when the work happens elsewhere.
 */
export type InteractionResponse =
  | { kind: 'update'; content?: string | null; embeds?: Embed[]; components?: ComponentRow[] }
  | { kind: 'reply'; content?: string | null; embeds?: Embed[]; components?: ComponentRow[] }
  | { kind: 'ack' };

/** What `live()`'s `render` may return, and what `edit` accepts. */
export interface RenderedCard {
  content?: string | null;
  embeds?: Embed[];
  components?: ComponentRow[];
}

/**
 * A duration. A number is milliseconds; a string is `30s`, `5m`, `1h`, `2d`.
 * `ms` is accepted too, for callers who already did the maths.
 */
export type LiveDuration = number | `${number}${'ms' | 's' | 'm' | 'h' | 'd'}`;

export interface LiveOptions {
  /**
   * How often to rewrite the card after the first post. Default `30s`.
   * Floored at ten seconds so a tight loop cannot chew the rate limit.
   */
  every?: LiveDuration;
  /**
   * When to stop rewriting. Default `1h`, capped at 24 hours, so a forgotten
   * live cannot run until the process dies.
   */
  until?: LiveDuration;
  /**
   * First post only. Edits never push a phone. Default `true` — a card that
   * rewrites itself is machine-pace, and a channel people mute is a channel
   * that swallows the one message that mattered. Set `false` when the first
   * post is the thing they asked for (a pasted contract address, a /status).
   */
  silent?: boolean;
  replyToId?: string;
  /** Idempotency key for the first post. Pass one if the send might be retried. */
  nonce?: string;
  /**
   * Called for the first post and every tick. Return `null` to skip a tick
   * (the card stays as it was). Throw and the tick is skipped, the live
   * continues — one bad lookup must not kill the card.
   */
  render: () => RenderedCard | null | Promise<RenderedCard | null>;
  onError?: (err: unknown) => void;
}

/** What `set` accepts: a card is content, not an event, so there is no nonce. */
export interface CardInput {
  content?: string | null;
  entities?: MessageEntity[];
  embeds?: unknown[];
  components?: unknown[];
  /** Whether the *first* post rings anybody. Rewrites never do. */
  silent?: boolean;
}

/** A named card on a board. See `bot.card()`. */
export interface BotCard {
  conversationId: string;
  key: string;
  /**
   * Create the card, or replace what is on it.
   *
   * Safe to call from a loop, a cron job, or a fresh process: the name is
   * what identifies the card, so there is nothing to remember between calls.
   */
  set(input: CardInput): Promise<{ message: IncomingMessage; created: boolean }>;
  /**
   * Take the card down.
   *
   * Only yours: two bots on one board can both own a `price`, so the name
   * alone does not identify a message. Throws `404` if there is nothing
   * under this name — which is also the answer after somebody deleted it
   * by hand.
   */
  remove(): Promise<{ deleted: boolean }>;
}

/** What a feed's `render()` returns: the card, without the delivery flags. */
export type FeedCard = Omit<CardInput, 'silent'>;

export interface FeedOptions {
  /**
   * How often to rewrite the card. Default `30s`, floored at ten seconds
   * because every write costs a send token and a feed is meant to run for
   * weeks.
   */
  every?: LiveDuration;
  /**
   * Whether the *first* post rings anybody. Default `true` — silent.
   * Rewrites never ring, whatever this says: they are edits.
   */
  silent?: boolean;
  /**
   * Called now, and on every tick. Return `null` to skip a tick and leave
   * the card as it is — which is the right answer when the upstream has
   * nothing new, and much better than writing the same value again.
   *
   * Throwing is survivable: the tick is skipped, the feed backs off, and
   * `onError` hears about it. Throwing on the *first* call is not — that
   * one rejects `feed()`, because a feed that never published anything is
   * a bug worth failing loudly.
   */
  render: () => FeedCard | null | Promise<FeedCard | null>;
  onError?: (err: unknown) => void;
}

/** A running feed. See `bot.feed()`. */
export interface Feed {
  readonly conversationId: string;
  readonly key: string;
  /**
   * The message the card lives on, once the first write has landed.
   *
   * For logging and for links. Do not store it: the whole point of a named
   * card is that the name is what survives, and this id changes if the card
   * is deleted and published again.
   */
  readonly messageId: string | null;
  readonly running: boolean;
  /** Stop rewriting. The card stays on the board with its last value. */
  stop(): void;
  /** Write now, without waiting for the next tick. */
  refresh(): Promise<void>;
}

export interface LiveCard {
  readonly conversationId: string;
  readonly messageId: string;
  readonly running: boolean;
  /** Stop rewriting. The card stays where it is. */
  stop(): void;
  /** Run `render()` now and edit, without waiting for the next tick. */
  refresh(): Promise<void>;
}
