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
