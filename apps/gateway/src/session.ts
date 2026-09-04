import type { WebSocket } from 'ws';
import {
  CloseCode,
  GatewayOp,
  encodeFrame,
  type EventName,
  type GatewayFrame,
  type PreparedDispatch,
} from '@yappy/shared';
import { env } from './env.js';

/**
 * One `Session` per socket.
 *
 * Sessions outlive their socket briefly: when a connection drops, the session
 * is parked for `SESSION_RESUME_WINDOW_MS` with its recent event buffer intact,
 * so a client coming out of a tunnel replays what it missed instead of
 * refetching everything. Mobile clients disconnect constantly; making that
 * cheap is most of what a chat gateway is for.
 */

export interface SessionUser {
  id: string;
  deviceId: string;
  tokenEpoch: number;
}

/** Small ring buffer of dispatched events, for RESUME. */
const REPLAY_BUFFER_SIZE = 256;
/** Outbound bytes a socket may have queued before it is judged not to be reading. */
const SLOW_CONSUMER_BYTES = 1024 * 1024;

export class Session {
  readonly id: string;
  readonly user: SessionUser;

  socket: WebSocket | null;
  /** Monotonic per-session dispatch counter. Clients ack it on RESUME. */
  seq = 0;
  /** Conversations this session is subscribed to. */
  readonly conversations = new Set<string>();
  /**
   * Each subscribed conversation's space, or null for a top-level one. Kept
   * so a kick from a space can drop its channels too: membership lives on
   * the space, and the eviction has to follow the same rule as the grant.
   */
  readonly parentOf = new Map<string, string | null>();

  lastHeartbeatAt = Date.now();
  disconnectedAt: number | null = null;
  presence: string = 'online';
  /**
   * Cached so RESUME can re-establish them: the presence row is deleted the
   * moment a socket closes, and a reconnect that only restored `presence`
   * would silently drop the custom status and the room the person was in.
   */
  customStatus: string | null = null;
  /** The conversation this session is looking at — ambient co-presence. */
  viewing: string | null = null;

  private readonly replay: Array<{ s: number; frame: string }> = [];
  private frameWindowStart = Date.now();
  private framesInWindow = 0;

  constructor(id: string, user: SessionUser, socket: WebSocket) {
    this.id = id;
    this.user = user;
    this.socket = socket;
  }

  get isConnected(): boolean {
    return this.socket !== null && this.socket.readyState === 1;
  }

  /** True once the resume window has elapsed and the session can be reaped. */
  isExpired(now = Date.now()): boolean {
    return this.disconnectedAt !== null && now - this.disconnectedAt > env.SESSION_RESUME_WINDOW_MS;
  }

  send(frame: GatewayFrame): void {
    if (!this.isConnected) return;
    try {
      this.socket!.send(encodeFrame(frame));
    } catch {
      // A failed write means the socket is already gone; the close handler
      // will park the session.
    }
  }

  /**
   * Send a named event and record it for replay.
   *
   * Buffering happens even while disconnected — that is the whole point. A
   * parked session keeps accumulating so a reconnect within the window can
   * catch up without touching the database.
   */
  dispatch(event: EventName, data: unknown): void {
    this.seq += 1;
    const frame: GatewayFrame = { op: GatewayOp.Dispatch, t: event, s: this.seq, d: data };
    this.emit(encodeFrame(frame));
  }

  /**
   * Dispatch an event whose payload the caller has already serialised.
   *
   * Only the sequence number differs between one broadcast's recipients, so a
   * fan-out prepares the frame once and each session concatenates its own `s`
   * into the gap. Identical output to `dispatch` — the difference is that a
   * group of 500 no longer runs `JSON.stringify` over the same message 500
   * times.
   */
  dispatchPrepared(prepared: PreparedDispatch): void {
    this.seq += 1;
    this.emit(`${prepared.head}${this.seq}${prepared.tail}`);
  }

  /** Buffer a finished frame for replay, and send it if anyone is listening. */
  private emit(encoded: string): void {
    this.replay.push({ s: this.seq, frame: encoded });
    if (this.replay.length > REPLAY_BUFFER_SIZE) this.replay.shift();

    if (this.isConnected) {
      // Backpressure. A client that stops reading (but keeps heartbeating)
      // had every outgoing frame queued in this process's heap without
      // bound. Past a megabyte it is closed as resumable: the replay buffer
      // covers what it missed, and its memory is returned now rather than
      // when the node falls over.
      if (this.socket!.bufferedAmount > SLOW_CONSUMER_BYTES) {
        this.close(CloseCode.SessionTimeout, 'slow consumer');
        return;
      }
      try {
        this.socket!.send(encoded);
      } catch {
        /* parked on close */
      }
    }
  }

  /**
   * Replay everything after `afterSeq`.
   *
   * Returns false when the client has fallen further behind than the buffer
   * holds — the caller then invalidates the session and the client does a full
   * IDENTIFY, which reconciles through the sync endpoint.
   */
  replayFrom(afterSeq: number): boolean {
    if (afterSeq > this.seq) return false; // client claims to be ahead of us
    const oldest = this.replay[0]?.s;
    if (afterSeq < (oldest ?? this.seq + 1) - 1) return false;

    for (const entry of this.replay) {
      if (entry.s > afterSeq && this.isConnected) {
        this.socket!.send(entry.frame);
      }
    }
    return true;
  }

  /**
   * Per-socket frame budget.
   *
   * Cheap and local: a client spamming typing indicators is stopped here rather
   * than reaching the database. Returns false when the budget is exhausted.
   */
  allowFrame(): boolean {
    const now = Date.now();
    if (now - this.frameWindowStart >= 1_000) {
      this.frameWindowStart = now;
      this.framesInWindow = 0;
    }
    this.framesInWindow += 1;
    return this.framesInWindow <= env.MAX_FRAMES_PER_SECOND;
  }

  park(): void {
    this.disconnectedAt = Date.now();
    this.socket = null;
  }

  resume(socket: WebSocket): void {
    this.socket = socket;
    this.disconnectedAt = null;
    this.lastHeartbeatAt = Date.now();
  }

  close(code: number = CloseCode.UnknownError, reason = ''): void {
    try {
      this.socket?.close(code, reason);
    } catch {
      /* already closed */
    }
    this.socket = null;
  }
}
