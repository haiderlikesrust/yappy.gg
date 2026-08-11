import type { YappyBot } from './client.js';
import type {
  IncomingMessage,
  InteractionPressedEvent,
  InteractionResponse,
  MessageCreatedEvent,
} from './types.js';

/**
 * Opcodes, copied rather than imported — same reasoning as `types.ts`. These
 * are the contract; the server's enum is an implementation of it.
 */
const Op = {
  Hello: 0,
  Identify: 1,
  Ready: 2,
  Heartbeat: 3,
  HeartbeatAck: 4,
  Dispatch: 5,
  InvalidSession: 8,
  Reconnect: 9,
  Command: 10,
} as const;

const PROTOCOL_VERSION = 1;

/** Close codes at or above this are final — retrying makes it worse. */
const FATAL_CLOSE = 4010;

export interface ConnectOptions {
  /** Defaults to production. Point at `ws://localhost:3001` when testing. */
  url?: string;
  onReady?: (data: { sessionId: string }) => void | Promise<void>;
  onMessage?: (event: MessageCreatedEvent['data']) => void | Promise<void>;
  /**
   * Return an {@link InteractionResponse} and the SDK applies it for you: an
   * `update` rewrites the card that was pressed, a `reply` posts a new
   * message. Returning nothing acknowledges the press and leaves the card
   * alone.
   */
  onInteraction?: (
    event: InteractionPressedEvent['data'],
  ) => InteractionResponse | void | Promise<InteractionResponse | void>;
  /** Anything thrown by your handlers lands here instead of killing the process. */
  onError?: (err: unknown) => void;
  /** Called on every disconnect, before the reconnect is scheduled. */
  onDisconnect?: (info: { code: number; reason: string; willRetry: boolean }) => void;
}

export interface Connection {
  /** Stop reconnecting and close. */
  close(): void;
  /** True while a socket is open and identified. */
  readonly connected: boolean;
}

/**
 * Hold a socket open and receive events, instead of being called at a URL.
 *
 * This is how a bot should run. A webhook needs a public HTTPS address, which
 * means a host or a tunnel before a bot can say a single word — and none of
 * that has anything to do with what the bot does. A socket dials *out*, so a
 * bot runs on a laptop, behind NAT, on a home connection, with a token and
 * nothing else. It is the same connection the phone apps hold.
 *
 * What arrives is the ordinary event stream for every conversation the bot is
 * a member of, because a bot is a member like anyone else. There is no
 * bot-specific delivery path to fall behind the real one.
 *
 * Reconnects on its own with backoff, and resubscribes when it is added to a
 * new group, so a long-running bot needs no supervision beyond a process
 * manager. Fatal closes — a revoked token, a rotated one — stop the loop
 * rather than hammering the server with a credential that will never work.
 *
 * Do not also set a webhook URL. Both transports deliver everything, so a bot
 * with both configured handles every event twice.
 */
export function connectGateway(bot: YappyBot, options: ConnectOptions = {}): Connection {
  const url = (options.url ?? 'wss://gateway.yappy.gg').replace(/\/+$/, '');
  let socket: WebSocket | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let closed = false;
  let identified = false;

  const fail = (err: unknown) => options.onError?.(err);

  const stopHeartbeat = () => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
  };

  const send = (frame: unknown) => {
    // readyState 1 is OPEN. Sending into a closing socket throws.
    if (socket && socket.readyState === 1) socket.send(JSON.stringify(frame));
  };

  const scheduleReconnect = (code: number, reason: string) => {
    stopHeartbeat();
    identified = false;
    socket = null;

    const willRetry = !closed && code < FATAL_CLOSE;
    options.onDisconnect?.({ code, reason, willRetry });
    if (!willRetry) return;

    // Exponential with a ceiling, and jittered: a gateway restart drops every
    // bot at once, and without jitter they all come back in the same
    // millisecond and drop it again.
    const base = Math.min(30_000, 1_000 * 2 ** attempt);
    attempt += 1;
    retryTimer = setTimeout(open, base / 2 + Math.random() * (base / 2));
  };

  const handleDispatch = (type: string, data: Record<string, unknown>) => {
    if (type === 'message.create') {
      const message = data as unknown as IncomingMessage;
      // A bot never hears its own messages back — the server excludes the
      // sender — but system lines ("X added Y") arrive here too, and almost no
      // bot wants them. They have no sender.
      if (!message.senderId) return;
      void Promise.resolve()
        .then(() => options.onMessage?.({ conversationId: message.conversationId, message }))
        .catch(fail);
      return;
    }

    if (type === 'interaction.create') {
      const press = data as unknown as InteractionPressedEvent['data'];
      void Promise.resolve()
        .then(async () => {
          const response = await options.onInteraction?.(press);
          if (!response || response.kind === 'ack') return;
          // The press came as an event, so there is no response body to put
          // this in. Same shape a webhook bot returns, applied by the same
          // code on the server.
          await bot.respondToInteraction(press.conversationId, press.messageId, response);
        })
        .catch(fail);
      return;
    }

    /**
     * Added to a group while running.
     *
     * Subscriptions are set at IDENTIFY, so without this a bot added to a new
     * group hears nothing from it until the next reconnect — which for a
     * healthy bot could be days. Someone adds the bot, pastes something, and
     * concludes it is broken.
     */
    if (type === 'conversation.create') {
      const id = typeof data.id === 'string' ? data.id : null;
      if (id) send({ op: Op.Command, d: { c: 'conversation.subscribe', conversationId: id } });
    }
  };

  const open = () => {
    if (closed) return;
    retryTimer = null;

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      fail(err);
      scheduleReconnect(1006, 'construct failed');
      return;
    }
    socket = ws;

    ws.addEventListener('message', (event) => {
      let frame: { op: number; t?: string; d?: unknown };
      try {
        frame = JSON.parse(String((event as MessageEvent).data));
      } catch (err) {
        fail(err);
        return;
      }

      switch (frame.op) {
        case Op.Hello: {
          const hello = (frame.d ?? {}) as { heartbeatIntervalMs?: number };
          send({ op: Op.Identify, d: { token: bot.credential, protocolVersion: PROTOCOL_VERSION } });
          stopHeartbeat();
          heartbeat = setInterval(() => send({ op: Op.Heartbeat }), hello.heartbeatIntervalMs ?? 30_000);
          // Do not hold the process open on the heartbeat alone; the socket
          // already does that, and this way `close()` lets the program exit.
          heartbeat.unref?.();
          break;
        }
        case Op.Ready: {
          identified = true;
          attempt = 0;
          const ready = (frame.d ?? {}) as { sessionId?: string };
          void Promise.resolve()
            .then(() => options.onReady?.({ sessionId: ready.sessionId ?? '' }))
            .catch(fail);
          break;
        }
        case Op.Dispatch: {
          if (frame.t) handleDispatch(frame.t, (frame.d ?? {}) as Record<string, unknown>);
          break;
        }
        case Op.InvalidSession:
        case Op.Reconnect: {
          // The server is telling us to start over. Closing here means the
          // reconnect goes through the one code path that knows about backoff.
          ws.close();
          break;
        }
        default:
          break;
      }
    });

    ws.addEventListener('close', (event) => {
      // Typed structurally rather than as `CloseEvent`: the DOM lib is not
      // pulled in here, and the two fields this needs are the two every
      // implementation has.
      const { code, reason } = event as unknown as { code?: number; reason?: string };
      scheduleReconnect(code || 1006, reason || '');
    });

    // An error is always followed by a close, which is where the reconnect
    // lives. This exists so the error is not swallowed.
    ws.addEventListener('error', () => fail(new Error('gateway socket error')));
  };

  open();

  return {
    close() {
      closed = true;
      stopHeartbeat();
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
      socket = null;
    },
    get connected() {
      return identified && socket?.readyState === 1;
    },
  };
}
