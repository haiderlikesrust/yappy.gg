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

export interface SendMessageInput {
  content?: string | null;
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

export interface LiveCard {
  readonly conversationId: string;
  readonly messageId: string;
  readonly running: boolean;
  /** Stop rewriting. The card stays where it is. */
  stop(): void;
  /** Run `render()` now and edit, without waiting for the next tick. */
  refresh(): Promise<void>;
}
