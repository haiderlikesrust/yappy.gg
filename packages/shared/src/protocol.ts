import { z } from 'zod';
import { PRESENCE_STATUSES } from './constants.js';

/**
 * WebSocket wire protocol.
 *
 * Shape is Discord-gateway-like because that design has proven itself for
 * exactly this problem: one multiplexed socket per device, opcode envelope,
 * monotonic sequence numbers, and session resume so a subway tunnel does not
 * cost you a full state refetch.
 *
 * Two sequence counters exist and they are NOT the same thing:
 *   • `s`  — per-socket-session event counter, used only for RESUME.
 *   • message `seq` — per-conversation monotonic message ordinal, used for
 *     ordering, unread math and the REST sync endpoint. Survives reconnects.
 */

export const PROTOCOL_VERSION = 1;

export const GatewayOp = {
  /** server → client, first frame: heartbeat interval + session id */
  Hello: 0,
  /** client → server: authenticate a fresh session */
  Identify: 1,
  /** server → client: initial state snapshot */
  Ready: 2,
  /** client → server */
  Heartbeat: 3,
  /** server → client */
  HeartbeatAck: 4,
  /** server → client: a named event, carries `t` and `s` */
  Dispatch: 5,
  /** client → server: replay missed events for an existing session */
  Resume: 6,
  /** server → client: replay finished */
  Resumed: 7,
  /** server → client: session is gone, re-IDENTIFY (bool = resumable) */
  InvalidSession: 8,
  /** server → client: close and reconnect (deploy, rebalance) */
  Reconnect: 9,
  /** client → server: request/action with an ack */
  Command: 10,
  /** server → client: result of a Command, echoes `nonce` */
  CommandAck: 11,
  /** server → client: protocol-level error */
  Error: 12,
} as const;

export type GatewayOpValue = (typeof GatewayOp)[keyof typeof GatewayOp];

/** Close codes above 4000 are ours. 4000-4009 are retryable; 4010+ are fatal. */
export const CloseCode = {
  UnknownError: 4000,
  RateLimited: 4008,
  SessionTimeout: 4009,
  AuthenticationFailed: 4010,
  AlreadyAuthenticated: 4011,
  NotAuthenticated: 4012,
  InvalidPayload: 4013,
  ProtocolVersionUnsupported: 4014,
  SessionRevoked: 4015,
  AccountSuspended: 4016,
} as const;

export const isResumable = (code: number): boolean => code < 4010;

// ─── Envelope ────────────────────────────────────────────────────────────────

export interface GatewayFrame<T = unknown> {
  op: GatewayOpValue;
  d?: T;
  /** Sequence number — present on Dispatch only. */
  s?: number;
  /** Event name — present on Dispatch only. */
  t?: EventName;
  /** Client-supplied correlation id — present on Command / CommandAck. */
  nonce?: string;
}

// ─── Handshake ───────────────────────────────────────────────────────────────

export interface HelloData {
  sessionId: string;
  heartbeatIntervalMs: number;
  protocolVersion: number;
}

export const identifySchema = z.object({
  token: z.string().min(1),
  protocolVersion: z.number().int().default(PROTOCOL_VERSION),
  deviceId: z.string().uuid().optional(),
  /** Client build info — powers force-upgrade and per-version feature gates. */
  client: z
    .object({
      platform: z.enum(['ios', 'android', 'web', 'desktop']),
      version: z.string().max(32),
      os: z.string().max(64).optional(),
      device: z.string().max(64).optional(),
    })
    .optional(),
  presence: z.enum(PRESENCE_STATUSES).optional(),
  /**
   * Conversations the client already has cached, with the highest `seq` it
   * holds. READY diffs against this and only sends what actually changed —
   * the difference between a 4 MB and a 4 KB reconnect on a busy account.
   */
  cursors: z
    .array(z.object({ conversationId: z.string().uuid(), seq: z.coerce.number().int().nonnegative() }))
    .max(500)
    .optional(),
});
export type IdentifyData = z.infer<typeof identifySchema>;

export const resumeSchema = z.object({
  token: z.string().min(1),
  sessionId: z.string().min(1),
  /** Last `s` the client successfully processed. */
  seq: z.number().int().nonnegative(),
});
export type ResumeData = z.infer<typeof resumeSchema>;

export interface ReadyData {
  sessionId: string;
  user: unknown;
  /** Conversations that changed since the client's cursors. */
  conversations: unknown[];
  /** Conversation ids the client cached that no longer exist / it was removed from. */
  removedConversations: string[];
  /** True when the delta was too large and the client should hard-refetch. */
  resyncRequired: boolean;
  serverTime: string;
}

// ─── Client → server commands ────────────────────────────────────────────────

export const CommandName = {
  TypingStart: 'typing.start',
  TypingStop: 'typing.stop',
  ReadAck: 'read.ack',
  /**
   * "This device has the message", distinct from "this human has seen it".
   * Sent automatically by clients as message events arrive; read.ack still
   * implies delivery, so a client that only ever read-acks stays correct.
   */
  DeliveryAck: 'delivery.ack',
  PresenceUpdate: 'presence.update',
  /** Subscribe to a conversation you are not a member of (public channel preview). */
  Subscribe: 'conversation.subscribe',
  Unsubscribe: 'conversation.unsubscribe',
  /** Ask the server who is online in a conversation (lazy — not pushed on READY). */
  PresenceQuery: 'presence.query',
  /**
   * "I am looking at this conversation right now", or null on leaving.
   *
   * Deliberately not `conversation.subscribe`: a session subscribes to every
   * conversation the account belongs to at IDENTIFY, so subscription says
   * nothing about attention. This is attention.
   */
  Viewing: 'conversation.viewing',
  CallSignal: 'call.signal',
  Ping: 'ping',
} as const;
export type CommandNameValue = (typeof CommandName)[keyof typeof CommandName];

export const commandSchema = z.discriminatedUnion('c', [
  z.object({ c: z.literal(CommandName.TypingStart), conversationId: z.string().uuid() }),
  z.object({ c: z.literal(CommandName.TypingStop), conversationId: z.string().uuid() }),
  z.object({
    c: z.literal(CommandName.ReadAck),
    conversationId: z.string().uuid(),
    seq: z.coerce.number().int().nonnegative(),
  }),
  z.object({
    c: z.literal(CommandName.DeliveryAck),
    conversationId: z.string().uuid(),
    seq: z.coerce.number().int().nonnegative(),
  }),
  z.object({
    c: z.literal(CommandName.PresenceUpdate),
    status: z.enum(PRESENCE_STATUSES),
    customStatus: z.string().max(128).nullish(),
  }),
  z.object({ c: z.literal(CommandName.Subscribe), conversationId: z.string().uuid() }),
  z.object({ c: z.literal(CommandName.Unsubscribe), conversationId: z.string().uuid() }),
  z.object({ c: z.literal(CommandName.PresenceQuery), conversationId: z.string().uuid() }),
  z.object({
    c: z.literal(CommandName.Viewing),
    /** Null means "I left" — the client sends it on navigating away. */
    conversationId: z.string().uuid().nullable(),
  }),
  z.object({
    c: z.literal(CommandName.CallSignal),
    callId: z.string().uuid(),
    /** Opaque payload relayed to the other participants (ICE restart hints, etc.). */
    payload: z.record(z.unknown()),
    to: z.array(z.string().uuid()).max(64).optional(),
  }),
  z.object({ c: z.literal(CommandName.Ping) }),
]);
export type Command = z.infer<typeof commandSchema>;

// ─── Server → client events ──────────────────────────────────────────────────

export const Event = {
  MessageCreate: 'message.create',
  MessageUpdate: 'message.update',
  MessageDelete: 'message.delete',
  MessageBulkDelete: 'message.bulk_delete',

  ReactionAdd: 'reaction.add',
  ReactionRemove: 'reaction.remove',
  ReactionClear: 'reaction.clear',

  PinAdd: 'pin.add',
  PinRemove: 'pin.remove',

  PollVote: 'poll.vote',
  PollClose: 'poll.close',

  ConversationCreate: 'conversation.create',
  ConversationUpdate: 'conversation.update',
  ConversationDelete: 'conversation.delete',
  /** Local-only state: mute, pin-to-top, archive. Sent to the owning user only. */
  ConversationStateUpdate: 'conversation.state_update',

  MemberAdd: 'member.add',
  MemberUpdate: 'member.update',
  MemberRemove: 'member.remove',

  TypingStart: 'typing.start',
  TypingStop: 'typing.stop',
  ReadReceipt: 'read.receipt',
  DeliveryReceipt: 'delivery.receipt',

  PresenceUpdate: 'presence.update',
  /**
   * Someone entered or left a conversation's "room" — ambient co-presence.
   * Published to the conversation topic, so it costs one notify regardless of
   * how many people are in the group.
   */
  ViewingUpdate: 'presence.viewing',

  UserUpdate: 'user.update',
  RelationshipUpdate: 'relationship.update',
  BlockUpdate: 'block.update',

  CallRing: 'call.ring',
  CallUpdate: 'call.update',
  CallParticipantUpdate: 'call.participant_update',
  CallEnd: 'call.end',
  CallSignal: 'call.signal',

  /**
   * A voice channel's roster changed. Published to the SPACE topic (one
   * subscription covers the whole channel list) with the full occupant
   * snapshot — snapshots self-heal where deltas drift.
   */
  VoiceState: 'voice.state',

  /**
   * A live location moved.
   *
   * Its own event rather than a `message.update`, because a share is hundreds
   * of pings and each one would otherwise rewrite a history row and hand every
   * client a whole message to re-render. This carries a point.
   */
  LocationUpdate: 'location.update',
  /** A live location stopped — the sender ended it, or it ran out. */
  LocationEnd: 'location.end',

  /**
   * Somebody pressed a button on a bot's card.
   *
   * Sent to the bot's own user topic, which a bot connected to the gateway is
   * subscribed to like any other session. This is the socket half of what a
   * webhook bot receives as `interaction.pressed`; a bot should be reached by
   * one transport or the other, not both.
   */
  InteractionCreate: 'interaction.create',

  StickerPackUpdate: 'sticker_pack.update',

  /** Another device on this account did something the UI must mirror. */
  SessionUpdate: 'session.update',
  /** Server asks the client to refetch a slice it can no longer stream. */
  Resync: 'resync',
} as const;

export type EventName = (typeof Event)[keyof typeof Event];

export interface TypingPayload {
  conversationId: string;
  userId: string;
  /** Server-computed expiry so clients do not need their own timers to agree. */
  expiresAt: string;
}

export interface ReadReceiptPayload {
  conversationId: string;
  userId: string;
  seq: number;
  readAt: string;
}

export interface PresencePayload {
  userId: string;
  status: (typeof PRESENCE_STATUSES)[number];
  customStatus?: string | null;
  lastSeenAt?: string | null;
}

export interface ViewingPayload {
  conversationId: string;
  userId: string;
  /** False means they left the room. */
  viewing: boolean;
}

export interface CallRingPayload {
  callId: string;
  conversationId: string | null;
  initiator: unknown;
  mode: 'audio' | 'video';
  /** Absolute deadline; the client stops ringing here even if it misses call.end. */
  expiresAt: string;
  participants: unknown[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function encodeFrame(frame: GatewayFrame): string {
  return JSON.stringify(frame);
}

/**
 * One broadcast's frame, split either side of the per-session sequence number.
 *
 * @see prepareDispatch — and keep both in step with `encodeFrame` above, which
 * is the definition of a frame's shape.
 */
export interface PreparedDispatch {
  /** Everything up to and including `"s":`. */
  readonly head: string;
  /** Everything from the comma after the sequence number to the closing brace. */
  readonly tail: string;
}

/**
 * Serialise one event once, for a fan-out that will send it to many sessions.
 *
 * Every recipient's frame is identical except for `s`, which is that session's
 * own sequence number — so the naive loop ran `JSON.stringify` over the whole
 * payload once per member. For a message into a 500-person group that is 500
 * serialisations of the same object: measured at 634µs per broadcast, against
 * 5µs for splitting it once and concatenating a number in.
 *
 * Returns `null` when the payload is `undefined`, because `JSON.stringify`
 * yields `undefined` rather than a string there and `encodeFrame` would omit
 * the key entirely. The caller falls back to the ordinary path rather than
 * emitting `"d":undefined`, which is not JSON.
 */
export function prepareDispatch(event: string, data: unknown): PreparedDispatch | null {
  const dataJson = JSON.stringify(data);
  if (dataJson === undefined) return null;
  return {
    head: `{"op":${GatewayOp.Dispatch},"t":${JSON.stringify(event)},"s":`,
    tail: `,"d":${dataJson}}`,
  };
}

export function decodeFrame(raw: string): GatewayFrame | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const frame = parsed as GatewayFrame;
    return typeof frame.op === 'number' ? frame : null;
  } catch {
    return null;
  }
}
