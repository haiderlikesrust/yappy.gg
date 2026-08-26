import {
  CommandName,
  GatewayOp,
  PROTOCOL_VERSION,
  isResumable,
  type EventName,
  type GatewayFrame,
  type HelloData,
  type ReadyData,
} from '@yappy/shared';
import { CLIENT_VERSION, GATEWAY_URL } from './config';

/**
 * The socket half of the client.
 *
 * Mirrors what the gateway expects (apps/gateway/src/server.ts): HELLO arrives
 * first with the heartbeat interval, the client answers IDENTIFY with a JWT,
 * READY carries the conversation delta, and everything after is DISPATCH
 * frames. On a drop we RESUME with the last processed `s`; if the server says
 * the session is gone we IDENTIFY fresh and hand the READY to the app again.
 *
 * The token is *fetched per connection attempt* rather than captured once —
 * access tokens outlive a laptop lid-close by minutes, not days, and a stale
 * token here would close every reconnect with 4010 until a REST call happened
 * to refresh it first.
 */

type Listener = (event: EventName, data: unknown) => void;

export interface GatewayHandlers {
  getToken: () => Promise<string | null>;
  onReady: (ready: ReadyData) => void;
  onEvent: Listener;
  onStatusChange?: (status: GatewayStatus) => void;
}

export type GatewayStatus = 'connecting' | 'online' | 'reconnecting' | 'offline';

export class GatewayClient {
  private handlers: GatewayHandlers;
  private socket: WebSocket | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private sessionId: string | null = null;
  private seq = 0;
  private nonceCounter = 0;
  private backoffMs = 1_000;
  private closedByUs = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Highest message seq per conversation, sent as cursors on IDENTIFY. */
  readonly cursors = new Map<string, number>();

  constructor(handlers: GatewayHandlers) {
    this.handlers = handlers;
  }

  connect(): void {
    this.closedByUs = false;
    this.open();
  }

  disconnect(): void {
    this.closedByUs = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopHeartbeat();
    this.socket?.close(1000);
    this.socket = null;
    this.sessionId = null;
    this.seq = 0;
  }

  private setStatus(status: GatewayStatus): void {
    this.handlers.onStatusChange?.(status);
  }

  private open(): void {
    this.setStatus(this.sessionId ? 'reconnecting' : 'connecting');
    const socket = new WebSocket(GATEWAY_URL);
    this.socket = socket;

    socket.onmessage = (raw) => {
      let frame: GatewayFrame;
      try {
        frame = JSON.parse(String(raw.data)) as GatewayFrame;
      } catch {
        return;
      }
      void this.onFrame(socket, frame);
    };

    socket.onclose = (ev) => {
      if (socket !== this.socket) return;
      this.stopHeartbeat();
      if (this.closedByUs) {
        this.setStatus('offline');
        return;
      }
      // Fatal close codes mean the session (or the token) is dead; a fresh
      // IDENTIFY with a fresh token is the answer either way.
      if (!isResumable(ev.code)) {
        this.sessionId = null;
        this.seq = 0;
      }
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      /* onclose always follows */
    };
  }

  private scheduleReconnect(): void {
    this.setStatus('reconnecting');
    const delay = this.backoffMs + Math.random() * 500;
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private async onFrame(socket: WebSocket, frame: GatewayFrame): Promise<void> {
    switch (frame.op) {
      case GatewayOp.Hello: {
        const hello = frame.d as HelloData;
        this.startHeartbeat(hello.heartbeatIntervalMs);

        const token = await this.handlers.getToken();
        if (!token) {
          socket.close(1000);
          return;
        }

        if (this.sessionId) {
          this.send({
            op: GatewayOp.Resume,
            d: { token, sessionId: this.sessionId, seq: this.seq },
          });
        } else {
          this.send({
            op: GatewayOp.Identify,
            d: {
              token,
              protocolVersion: PROTOCOL_VERSION,
              client: { platform: 'web', version: CLIENT_VERSION },
              presence: 'online',
              cursors: [...this.cursors.entries()]
                .slice(0, 500)
                .map(([conversationId, seq]) => ({ conversationId, seq })),
            },
          });
        }
        return;
      }

      case GatewayOp.Ready: {
        const ready = frame.d as ReadyData;
        this.sessionId = ready.sessionId;
        this.seq = 0;
        this.backoffMs = 1_000;
        this.setStatus('online');
        this.handlers.onReady(ready);
        return;
      }

      case GatewayOp.Resumed: {
        this.backoffMs = 1_000;
        this.setStatus('online');
        return;
      }

      case GatewayOp.Dispatch: {
        if (typeof frame.s === 'number') this.seq = frame.s;
        if (frame.t) this.handlers.onEvent(frame.t, frame.d);
        return;
      }

      case GatewayOp.HeartbeatAck:
        return;

      case GatewayOp.InvalidSession: {
        // Session unrecoverable — the server closes right after this. Clear
        // ours so the reconnect does a full IDENTIFY.
        this.sessionId = null;
        this.seq = 0;
        return;
      }

      case GatewayOp.Reconnect: {
        // Rolling deploy: the server asks nicely before the close lands.
        this.socket?.close(4000);
        return;
      }

      default:
        return;
    }
  }

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      this.send({ op: GatewayOp.Heartbeat });
    }, Math.max(intervalMs - 2_000, 5_000));
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private send(frame: GatewayFrame): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(frame));
    }
  }

  // ── Commands ──────────────────────────────────────────────────────────────

  private command(c: Record<string, unknown>): void {
    this.nonceCounter += 1;
    this.send({ op: GatewayOp.Command, nonce: `n${this.nonceCounter}`, d: c });
  }

  readAck(conversationId: string, seq: number): void {
    this.command({ c: CommandName.ReadAck, conversationId, seq });
  }

  deliveryAck(conversationId: string, seq: number): void {
    this.command({ c: CommandName.DeliveryAck, conversationId, seq });
  }

  typingStart(conversationId: string): void {
    this.command({ c: CommandName.TypingStart, conversationId });
  }

  typingStop(conversationId: string): void {
    this.command({ c: CommandName.TypingStop, conversationId });
  }

  viewing(conversationId: string | null): void {
    this.command({ c: CommandName.Viewing, conversationId });
  }

  /**
   * Subscribe to a conversation's event topic.
   *
   * The gateway subscribes a session to every membership at IDENTIFY — but
   * only the ones that exist at that moment. A conversation created while the
   * socket is up (a fresh DM, being added to a group) arrives as a
   * `conversation.create` event on the user topic, and its own topic must be
   * subscribed explicitly or every message in it is silence until the next
   * reconnect. The welcome DM hits exactly this: it is created by a queued
   * job seconds after registration, when the socket is already identified.
   */
  subscribe(conversationId: string): void {
    this.command({ c: CommandName.Subscribe, conversationId });
  }

  /** Presence + custom status. `customStatus` undefined leaves it alone; null clears. */
  setPresence(status: 'online' | 'idle' | 'dnd' | 'invisible', customStatus?: string | null): void {
    this.command({
      c: CommandName.PresenceUpdate,
      status,
      ...(customStatus !== undefined ? { customStatus } : {}),
    });
  }
}
