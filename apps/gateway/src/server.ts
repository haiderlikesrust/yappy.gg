import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { uuidv7 } from 'uuidv7';
import { jwtVerify } from 'jose';
import {
  PgBus,
  alias,
  and,
  applications,
  conversationMembers,
  conversations,
  createDb,
  devices,
  eq,
  isNull,
  sql as raw,
  topicForConversation,
  users,
  type Database,
} from '@yappy/db';
import {
  CloseCode,
  CommandName,
  Event,
  GatewayOp,
  LIMITS,
  PROTOCOL_VERSION,
  commandSchema,
  decodeFrame,
  identifySchema,
  resumeSchema,
  type GatewayFrame,
} from '@yappy/shared';
import pino from 'pino';
import { NODE_ID, env } from './env.js';
import { PresenceTracker } from './presence.js';
import { Session } from './session.js';
import { SubscriptionManager } from './subscriptions.js';

const log = pino({
  level: env.LOG_LEVEL,
  ...(env.NODE_ENV === 'production'
    ? {}
    : { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }),
  base: { node: NODE_ID },
});

const secret = new TextEncoder().encode(env.JWT_SECRET);

/**
 * Where membership lives.
 *
 * A channel borrows its member list from its space. Joining a space makes
 * someone a member of every channel in it, and they only get a row of their own
 * in one the first time something has to be written down there — a read cursor,
 * a draft (`materialiseChannelMember`, API side). The REST layer has resolved
 * membership that way from the start.
 *
 * This gateway did not. It asked for a literal `conversation_members` row on
 * the channel id, so for anyone who had joined a space but not yet spoken in a
 * given channel: nothing subscribed at IDENTIFY, `not_a_member` back from
 * `conversation.subscribe`, and therefore no live messages, no typing, nobody
 * shown as online or in the room. The channel appeared to work only because
 * reopening it refetched history over REST, which was never fooled.
 *
 * `coalesce(parent_id, id)` asks the question the rest of the app asks: who
 * does the *space* admit. Every membership check below goes through it.
 */
/** A channel's own member row, when it has one. Its authority is the space's. */
const ownMembers = alias(conversationMembers, 'own_members');

export class Gateway {
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private readonly db: Database;
  private readonly sqlPool;
  private readonly bus: PgBus;
  private readonly subscriptions: SubscriptionManager;
  private readonly presence: PresenceTracker;

  /** sessionId → Session, including parked (disconnected) sessions. */
  private readonly sessions = new Map<string, Session>();
  /** userId → sessionIds, for per-user connection caps and targeted sends. */
  private readonly byUser = new Map<string, Set<string>>();
  private sweeper: NodeJS.Timeout | null = null;

  constructor() {
    const { db, sql } = createDb({ url: env.DATABASE_URL, max: env.DATABASE_MAX_POOL });
    this.db = db;
    this.sqlPool = sql;

    this.bus = new PgBus(env.DATABASE_URL, sql, (err, ctx) => log.error({ err, ctx }, 'bus error'));
    this.subscriptions = new SubscriptionManager(this.bus, (err, ctx) => log.error({ err, ctx }, 'subscription error'));
    this.presence = new PresenceTracker(db, (err, ctx) => log.error({ err, ctx }, 'presence error'));

    this.http = createServer((req, res) => {
      if (req.url === '/health' || req.url === '/ready') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            node: NODE_ID,
            sessions: this.sessions.size,
            connected: this.presence.count,
            ...this.subscriptions.stats,
          }),
        );
        return;
      }
      res.writeHead(404).end();
    });

    this.wss = new WebSocketServer({
      server: this.http,
      // Chat payloads are small and highly compressible, but permessage-deflate
      // allocates a zlib context per socket — at 50k sockets that is gigabytes.
      // Off by default; enable only if bandwidth becomes the binding constraint.
      perMessageDeflate: false,
      maxPayload: 256 * 1024,
    });
  }

  async start(): Promise<void> {
    await this.presence.start();

    this.wss.on('connection', (socket, req) => this.onConnection(socket, req));

    // Reap parked sessions whose resume window has closed, and drop sockets
    // that stopped heartbeating (a half-open TCP connection looks alive to the
    // OS indefinitely — this is the only thing that detects it).
    this.sweeper = setInterval(() => this.sweep(), 15_000);
    this.sweeper.unref();

    await new Promise<void>((resolve) => this.http.listen(env.GATEWAY_PORT, env.HOST, resolve));
    log.info({ port: env.GATEWAY_PORT, node: NODE_ID }, 'gateway listening');
  }

  // ── Connection lifecycle ──────────────────────────────────────────────────

  private onConnection(socket: WebSocket, req: IncomingMessage): void {
    let session: Session | null = null;
    let identified = false;

    const helloSessionId = uuidv7();
    const frame: GatewayFrame = {
      op: GatewayOp.Hello,
      d: {
        sessionId: helloSessionId,
        heartbeatIntervalMs: env.HEARTBEAT_INTERVAL_MS,
        protocolVersion: PROTOCOL_VERSION,
      },
    };
    socket.send(JSON.stringify(frame));

    // A socket that never identifies is a resource leak or a probe.
    const identifyTimeout = setTimeout(() => {
      if (!identified) socket.close(CloseCode.NotAuthenticated, 'identify timeout');
    }, 20_000);
    identifyTimeout.unref();

    /**
     * Frames are processed strictly in order.
     *
     * Without this chain each frame starts its own async task, and a client
     * that sends a command the instant it receives READY races the assignment
     * of `session` — the command lands while `session` is still null and the
     * socket gets closed with "command before identify". Which is exactly what
     * a well-written client does: subscribe, ack reads, start typing, all
     * immediately on READY.
     */
    let queue: Promise<void> = Promise.resolve();
    socket.on('message', (data) => {
      queue = queue.then(async () => {
        const parsed = decodeFrame(data.toString());
        if (!parsed) {
          socket.close(CloseCode.InvalidPayload, 'malformed frame');
          return;
        }

        if (session && !session.allowFrame()) {
          socket.close(CloseCode.RateLimited, 'too many frames');
          return;
        }

        try {
          switch (parsed.op) {
            case GatewayOp.Identify: {
              if (identified) {
                socket.close(CloseCode.AlreadyAuthenticated, 'already identified');
                return;
              }
              identified = true;
              clearTimeout(identifyTimeout);
              session = await this.handleIdentify(socket, parsed, helloSessionId, req);
              break;
            }
            case GatewayOp.Resume: {
              if (identified) {
                socket.close(CloseCode.AlreadyAuthenticated, 'already identified');
                return;
              }
              identified = true;
              clearTimeout(identifyTimeout);
              session = await this.handleResume(socket, parsed);
              break;
            }
            case GatewayOp.Heartbeat: {
              if (!session) {
                socket.close(CloseCode.NotAuthenticated, 'heartbeat before identify');
                return;
              }
              session.lastHeartbeatAt = Date.now();
              session.send({ op: GatewayOp.HeartbeatAck });
              break;
            }
            case GatewayOp.Command: {
              if (!session) {
                socket.close(CloseCode.NotAuthenticated, 'command before identify');
                return;
              }
              await this.handleCommand(session, parsed);
              break;
            }
            default:
              session?.send({
                op: GatewayOp.Error,
                d: { message: `Unsupported opcode ${parsed.op}` },
              });
          }
        } catch (err) {
          log.error({ err, op: parsed.op }, 'frame handling failed');
          if (parsed.nonce && session) {
            session.send({
              op: GatewayOp.CommandAck,
              nonce: parsed.nonce,
              d: { ok: false, error: 'internal_error' },
            });
          }
        }
      });
      // A rejection here would leave the chain permanently rejected and silently
      // drop every subsequent frame on this socket.
      queue = queue.catch((err) => {
        log.error({ err }, 'frame queue error');
      });
    });

    socket.on('close', () => {
      clearTimeout(identifyTimeout);
      if (session) void this.onDisconnect(session);
    });

    socket.on('error', (err) => {
      log.debug({ err }, 'socket error');
    });
  }

  private async handleIdentify(
    socket: WebSocket,
    frame: GatewayFrame,
    sessionId: string,
    req: IncomingMessage,
  ): Promise<Session | null> {
    const parsed = identifySchema.safeParse(frame.d);
    if (!parsed.success) {
      socket.close(CloseCode.InvalidPayload, 'invalid identify');
      return null;
    }
    if (parsed.data.protocolVersion !== PROTOCOL_VERSION) {
      socket.close(CloseCode.ProtocolVersionUnsupported, 'unsupported protocol version');
      return null;
    }

    const auth = await this.authenticate(parsed.data.token);
    if (!auth) {
      socket.close(CloseCode.AuthenticationFailed, 'invalid token');
      return null;
    }

    // Cap connections per user. Without it a buggy client reconnect loop takes
    // a node down on its own.
    const existing = this.byUser.get(auth.id);
    if (existing && existing.size >= env.MAX_CONNECTIONS_PER_USER) {
      const oldest = [...existing][0];
      const victim = oldest ? this.sessions.get(oldest) : undefined;
      victim?.close(CloseCode.SessionRevoked, 'too many connections');
      if (oldest) await this.destroySession(oldest);
    }

    const session = new Session(sessionId, auth, socket);
    this.sessions.set(sessionId, session);
    this.byUser.set(auth.id, (this.byUser.get(auth.id) ?? new Set()).add(sessionId));

    await this.subscriptions.addUser(session);

    // Every conversation this account can receive events for, channels
    // included — see "Where membership lives" at the top of this file.
    const memberships = (await this.db.execute(
      raw`select c.id
            from conversations c
            join conversation_members m
              on m.conversation_id = coalesce(c.parent_id, c.id)
             and m.user_id = ${auth.id}::uuid
             and m.left_at is null
           where c.deleted_at is null`,
    )) as unknown as Array<{ id: string }>;

    await this.subscriptions.addConversations(
      session,
      memberships.map((m) => m.id),
    );

    await this.presence.connect(auth.deviceId, auth.id, parsed.data.presence ?? 'online');
    session.presence = parsed.data.presence ?? 'online';

    /**
     * Coming online *is* delivery.
     *
     * Everything that arrived while this account had no connected device is,
     * as of this handshake, on a device: the session now holds subscriptions
     * to every conversation and the client reconciles the backlog over REST
     * the moment READY lands. One statement advances the watermark for all of
     * them, and the DMs that actually moved get their receipt published — so
     * a sender staring at a single grey tick sees it double the moment the
     * recipient's phone comes back, which is exactly the WhatsApp behaviour
     * people's thumbs already know.
     *
     * Best-effort: a failure here costs a tick an update, not the session.
     */
    try {
      const advanced = (await this.db.execute(
        raw`update conversation_members m
               set last_delivered_seq = c.message_seq
              from conversations c
             where c.id = m.conversation_id
               and m.user_id = ${auth.id}::uuid
               and m.left_at is null
               and c.deleted_at is null
               and m.last_delivered_seq < c.message_seq
            returning m.conversation_id, m.last_delivered_seq, c.type`,
      )) as unknown as Array<{ conversation_id: string; last_delivered_seq: number; type: string }>;

      const deliveredAt = new Date().toISOString();
      for (const row of advanced) {
        if (row.type !== 'dm') continue;
        await this.bus.publish(topicForConversation(row.conversation_id), {
          t: Event.DeliveryReceipt,
          d: {
            conversationId: row.conversation_id,
            userId: auth.id,
            seq: Number(row.last_delivered_seq),
            deliveredAt,
          },
          exclude: [auth.id],
        });
      }
    } catch (err) {
      log.warn({ err, userId: auth.id }, 'delivery catch-up failed');
    }

    // READY carries only the delta against the client's cursors. A returning
    // client with a warm cache gets a payload measured in kilobytes.
    const ready = await this.buildReady(auth.id, sessionId, parsed.data.cursors ?? []);
    session.send({ op: GatewayOp.Ready, d: ready });

    await this.bus.publish(`u_${auth.id.replace(/-/g, '')}`, {
      t: Event.PresenceUpdate,
      d: { userId: auth.id, status: session.presence },
    });

    log.debug({ userId: auth.id, sessionId }, 'session ready');
    return session;
  }

  private async handleResume(socket: WebSocket, frame: GatewayFrame): Promise<Session | null> {
    const parsed = resumeSchema.safeParse(frame.d);
    if (!parsed.success) {
      socket.close(CloseCode.InvalidPayload, 'invalid resume');
      return null;
    }

    const auth = await this.authenticate(parsed.data.token);
    if (!auth) {
      socket.close(CloseCode.AuthenticationFailed, 'invalid token');
      return null;
    }

    const session = this.sessions.get(parsed.data.sessionId);
    // Resuming someone else's session must be impossible even with a valid
    // token of your own.
    if (!session || session.user.id !== auth.id || session.isExpired()) {
      socket.send(JSON.stringify({ op: GatewayOp.InvalidSession, d: false }));
      socket.close(CloseCode.SessionTimeout, 'session not resumable');
      return null;
    }

    session.resume(socket);
    if (!session.replayFrom(parsed.data.seq)) {
      // Client fell behind the replay buffer. Tell it to re-IDENTIFY; the sync
      // endpoint will reconcile from `seq` cursors.
      socket.send(JSON.stringify({ op: GatewayOp.InvalidSession, d: false }));
      socket.close(CloseCode.SessionTimeout, 'replay buffer exceeded');
      await this.destroySession(session.id);
      return null;
    }

    session.send({ op: GatewayOp.Resumed, d: { sessionId: session.id, seq: session.seq } });
    await this.presence.connect(auth.deviceId, auth.id, session.presence);

    // The presence row was deleted on disconnect and re-inserted just now, so
    // the room this session was sitting in has to be re-established — otherwise
    // a tunnel blip silently empties someone out of a chat they never left.
    if (session.viewing) {
      const { entered } = await this.presence.setViewing(auth.deviceId, session.viewing);
      if (entered && (await this.presence.allowsAmbientPresence(auth.id))) {
        await this.announceViewing(auth.id, null, entered);
      }
    }

    log.debug({ userId: auth.id, sessionId: session.id }, 'session resumed');
    return session;
  }

  private async onDisconnect(session: Session): Promise<void> {
    session.park();

    const result = await this.presence.disconnect(session.user.deviceId);
    if (result?.nowOffline) {
      await this.bus.publish(`u_${session.user.id.replace(/-/g, '')}`, {
        t: Event.PresenceUpdate,
        d: { userId: session.user.id, status: 'offline', lastSeenAt: new Date().toISOString() },
      });
    }
    // Leaving the app is leaving the room. This has to happen on close rather
    // than in `sweep()`, or a "here now" strip keeps showing someone for the
    // length of the whole resume window after they have gone.
    if (result?.wasViewing && (await this.presence.allowsAmbientPresence(session.user.id))) {
      await this.announceViewing(session.user.id, result.wasViewing, null);
    }
    // Subscriptions are NOT dropped here — the session is parked and may resume
    // within the window. They go when `sweep()` reaps it.
  }

  /**
   * Broadcast a room entry and/or exit to the conversation topics involved.
   *
   * The leave is conditional on the person having no *other* device still in
   * that room: someone reading on their phone with the desktop app open in the
   * background is present once, not twice, and closing one of them should not
   * remove their face.
   */
  private async announceViewing(
    userId: string,
    left: string | null,
    entered: string | null,
  ): Promise<void> {
    if (left) {
      const remaining = await this.presence.viewersOf(left);
      if (!remaining.includes(userId)) {
        await this.bus.publish(topicForConversation(left), {
          t: Event.ViewingUpdate,
          d: { conversationId: left, userId, viewing: false },
        });
      }
    }
    if (entered) {
      await this.bus.publish(topicForConversation(entered), {
        t: Event.ViewingUpdate,
        d: { conversationId: entered, userId, viewing: true },
      });
    }
  }

  private async destroySession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.subscriptions.removeAll(session);
    this.sessions.delete(sessionId);

    const set = this.byUser.get(session.user.id);
    set?.delete(sessionId);
    if (set && set.size === 0) this.byUser.delete(session.user.id);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.isExpired(now)) {
        void this.destroySession(id);
        continue;
      }
      if (
        session.isConnected &&
        now - session.lastHeartbeatAt > env.HEARTBEAT_INTERVAL_MS + env.HEARTBEAT_TIMEOUT_MS
      ) {
        log.debug({ sessionId: id }, 'heartbeat timeout');
        session.close(CloseCode.SessionTimeout, 'heartbeat timeout');
      }
    }
  }

  // ── Commands ──────────────────────────────────────────────────────────────

  private async handleCommand(session: Session, frame: GatewayFrame): Promise<void> {
    const parsed = commandSchema.safeParse(frame.d);
    if (!parsed.success) {
      session.send({ op: GatewayOp.CommandAck, nonce: frame.nonce, d: { ok: false, error: 'invalid_command' } });
      return;
    }

    const command = parsed.data;
    const ack = (data: unknown = { ok: true }) => {
      if (frame.nonce) session.send({ op: GatewayOp.CommandAck, nonce: frame.nonce, d: data });
    };

    switch (command.c) {
      case CommandName.Ping:
        ack({ ok: true, serverTime: new Date().toISOString() });
        return;

      case CommandName.TypingStart:
      case CommandName.TypingStop: {
        if (!session.conversations.has(command.conversationId)) {
          ack({ ok: false, error: 'not_a_member' });
          return;
        }
        const starting = command.c === CommandName.TypingStart;
        // Never persisted — see presence.ts for why.
        await this.bus.publish(topicForConversation(command.conversationId), {
          t: starting ? Event.TypingStart : Event.TypingStop,
          d: {
            conversationId: command.conversationId,
            userId: session.user.id,
            expiresAt: new Date(Date.now() + LIMITS.typingTtlSeconds * 1000).toISOString(),
          },
          exclude: [session.user.id],
        });
        ack();
        return;
      }

      /**
       * "My device has this message" — the grey second tick.
       *
       * Distinct from ReadAck on purpose: delivery says the bytes arrived,
       * reading says a human saw them, and WhatsApp taught everyone the
       * difference. Clients send this automatically as message events arrive,
       * including for conversations that are not open on screen.
       *
       * The receipt is published for DMs only. In a group, every member's
       * device acks every message — fanning that back out is N² chatter for a
       * state the group UI does not even render (the seen-by sheet reads the
       * REST endpoint on demand). The row is still written for groups, so the
       * data is there the moment a UI wants it.
       */
      case CommandName.DeliveryAck: {
        if (!session.conversations.has(command.conversationId)) {
          ack({ ok: false, error: 'not_a_member' });
          return;
        }
        const runDelivery = async () =>
          (await this.db.execute(
            raw`update conversation_members m
                   set last_delivered_seq = least(greatest(m.last_delivered_seq, ${command.seq}), c.message_seq)
                  from conversations c
                 where c.id = m.conversation_id
                   and m.conversation_id = ${command.conversationId}::uuid
                   and m.user_id = ${session.user.id}::uuid
                returning m.last_delivered_seq, c.type`,
          )) as unknown as Array<{ last_delivered_seq: number; type: string }>;

        let rows = await runDelivery();
        // A space member acking in a channel they have never written in has no
        // row to write to yet. Make one, exactly as the REST path does, rather
        // than telling a member they are not a member.
        if (
          rows.length === 0 &&
          (await this.materialiseChannelMember(command.conversationId, session.user.id))
        ) {
          rows = await runDelivery();
        }

        const row = rows[0];
        if (!row) {
          ack({ ok: false, error: 'not_a_member' });
          return;
        }

        if (row.type === 'dm') {
          await this.bus.publish(topicForConversation(command.conversationId), {
            t: Event.DeliveryReceipt,
            d: {
              conversationId: command.conversationId,
              userId: session.user.id,
              seq: Number(row.last_delivered_seq),
              deliveredAt: new Date().toISOString(),
            },
            exclude: [session.user.id],
          });
        }

        ack({ ok: true, lastDeliveredSeq: Number(row.last_delivered_seq) });
        return;
      }

      case CommandName.ReadAck: {
        if (!session.conversations.has(command.conversationId)) {
          ack({ ok: false, error: 'not_a_member' });
          return;
        }
        // Monotonic and clamped to the conversation head in one statement, so
        // two devices acking out of order cannot move the cursor backwards.
        const runRead = async () =>
          (await this.db.execute(
            raw`update conversation_members m
                   set last_read_seq = least(greatest(m.last_read_seq, ${command.seq}), c.message_seq),
                       last_delivered_seq = greatest(m.last_delivered_seq, ${command.seq}),
                       last_read_at = now()
                  from conversations c
                 where c.id = m.conversation_id
                   and m.conversation_id = ${command.conversationId}::uuid
                   and m.user_id = ${session.user.id}::uuid
                returning m.last_read_seq, m.mention_count, c.message_seq`,
          )) as unknown as Array<{ last_read_seq: number; mention_count: number; message_seq: number }>;

        let rows = await runRead();
        // Same as above: reading a channel is the commonest way to be there for
        // the first time, and it has to clear the badge like anywhere else.
        if (
          rows.length === 0 &&
          (await this.materialiseChannelMember(command.conversationId, session.user.id))
        ) {
          rows = await runRead();
        }

        const row = rows[0];
        if (!row) {
          ack({ ok: false, error: 'not_a_member' });
          return;
        }

        await this.bus.publish(topicForConversation(command.conversationId), {
          t: Event.ReadReceipt,
          d: {
            conversationId: command.conversationId,
            userId: session.user.id,
            seq: Number(row.last_read_seq),
            readAt: new Date().toISOString(),
          },
          exclude: [session.user.id],
        });

        /**
         * The acker's own devices, home screens included.
         *
         * The REST markRead path has always echoed ConversationStateUpdate to
         * the user topic; this path answered only in the command ack — which
         * the open chat consumed and the conversation list never saw. The
         * visible symptom: reading a chat did not clear its unread badge, and
         * the only things that did were replying (a send rewrites the row) or
         * the next cold sync. Same event, same shape, both write paths.
         */
        await this.bus.publish(`u_${session.user.id.replace(/-/g, '')}`, {
          t: Event.ConversationStateUpdate,
          d: {
            conversationId: command.conversationId,
            lastReadSeq: Number(row.last_read_seq),
            unreadCount: Math.max(0, Number(row.message_seq) - Number(row.last_read_seq)),
            mentionCount: Number(row.mention_count),
          },
        });

        ack({
          ok: true,
          lastReadSeq: Number(row.last_read_seq),
          unreadCount: Math.max(0, Number(row.message_seq) - Number(row.last_read_seq)),
          mentionCount: row.mention_count,
        });
        return;
      }

      case CommandName.PresenceUpdate: {
        session.presence = command.status;
        // `undefined` (field omitted) leaves the stored text alone; an explicit
        // null clears it. Before this the value was echoed on the bus and never
        // written, so a status set over the socket survived exactly until the
        // next reconnect.
        const custom = command.customStatus === undefined ? undefined : (command.customStatus ?? null);
        if (custom !== undefined) session.customStatus = custom;
        await this.presence.setStatus(session.user.deviceId, command.status, custom);
        await this.bus.publish(`u_${session.user.id.replace(/-/g, '')}`, {
          t: Event.PresenceUpdate,
          d: {
            userId: session.user.id,
            status: command.status,
            customStatus: custom === undefined ? session.customStatus : custom,
          },
        });
        ack();
        return;
      }

      case CommandName.Subscribe: {
        // Only for conversations the user is actually in — the gateway is not
        // a place to widen access. A channel's membership is its space's.
        const member = (await this.db.execute(
          raw`select 1
                from conversations c
                join conversation_members m
                  on m.conversation_id = coalesce(c.parent_id, c.id)
                 and m.user_id = ${session.user.id}::uuid
                 and m.left_at is null
               where c.id = ${command.conversationId}::uuid
                 and c.deleted_at is null
               limit 1`,
        )) as unknown as unknown[];
        if (member.length === 0) {
          ack({ ok: false, error: 'not_a_member' });
          return;
        }
        await this.subscriptions.add(topicForConversation(command.conversationId), session);
        session.conversations.add(command.conversationId);
        ack();
        return;
      }

      case CommandName.Unsubscribe: {
        this.subscriptions.remove(topicForConversation(command.conversationId), session);
        session.conversations.delete(command.conversationId);
        ack();
        return;
      }

      case CommandName.PresenceQuery: {
        // Membership check on the *caller*, which this never had: it happily
        // told anyone who is online in any conversation. It matters more now
        // that the same reply carries who is sitting in the room.
        if (!session.conversations.has(command.conversationId)) {
          ack({ ok: false, error: 'not_a_member' });
          return;
        }
        const rows = (await this.db.execute(
          raw`select distinct p.user_id, p.status
                from conversations c
                join conversation_members m
                  on m.conversation_id = coalesce(c.parent_id, c.id)
                 and m.left_at is null
                join presence p
                  on p.user_id = m.user_id
                 and p.expires_at > now()
               where c.id = ${command.conversationId}::uuid`,
        )) as unknown as Array<{ user_id: string; status: string }>;
        ack({
          ok: true,
          online: rows.map((r) => ({ userId: r.user_id, status: r.status })),
          viewing: await this.presence.viewersOf(command.conversationId),
        });
        return;
      }

      /**
       * Ambient co-presence: "I am in this room."
       *
       * The broadcast goes to the conversation topic, so it is one notify no
       * matter how many people are in the group, and it is suppressed entirely
       * for anyone who has turned the setting off — they still get to *see* the
       * room, they just do not appear in it.
       */
      case CommandName.Viewing: {
        const target = command.conversationId;
        if (target && !session.conversations.has(target)) {
          ack({ ok: false, error: 'not_a_member' });
          return;
        }

        const { left, entered } = await this.presence.setViewing(session.user.deviceId, target);
        if (left === null && entered === null) {
          // Same room as before — nothing changed, so nothing to say.
          ack();
          return;
        }
        session.viewing = target;

        if (await this.presence.allowsAmbientPresence(session.user.id)) {
          await this.announceViewing(session.user.id, left, entered);
        }
        ack();
        return;
      }

      case CommandName.CallSignal: {
        // Opaque relay. The gateway does not interpret call payloads; it only
        // enforces that the sender is a participant.
        const rows = (await this.db.execute(
          raw`select 1 from call_participants
               where call_id = ${command.callId}::uuid and user_id = ${session.user.id}::uuid`,
        )) as unknown as unknown[];
        if (rows.length === 0) {
          ack({ ok: false, error: 'not_a_participant' });
          return;
        }
        const targets = (await this.db.execute(
          raw`select user_id from call_participants where call_id = ${command.callId}::uuid`,
        )) as unknown as Array<{ user_id: string }>;

        const recipients = command.to ?? targets.map((t) => t.user_id);
        await this.bus.publishMany(
          recipients
            .filter((userId) => userId !== session.user.id)
            .map((userId) => `u_${userId.replace(/-/g, '')}`),
          {
            t: Event.CallSignal,
            d: { callId: command.callId, from: session.user.id, payload: command.payload },
          },
        );
        ack();
        return;
      }
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Give a space member their own row in one of its channels.
   *
   * The same insert as `materialiseChannelMember` on the API side, and here for
   * the same reason: a channel membership can be *read* without a row, but a
   * read cursor has to be written to one. Only reached when an ack found
   * nothing to update, so the ordinary path is still a single statement.
   *
   * Returns whether a row now exists to write to.
   */
  private async materialiseChannelMember(conversationId: string, userId: string): Promise<boolean> {
    const rows = (await this.db.execute(
      raw`insert into conversation_members (conversation_id, user_id, role, joined_at, history_start_seq)
          select c.id, ${userId}::uuid, pm.role, now(), 0
            from conversations c
            join conversation_members pm
              on pm.conversation_id = c.parent_id
             and pm.user_id = ${userId}::uuid
             and pm.left_at is null
           where c.id = ${conversationId}::uuid and c.parent_id is not null
          on conflict (conversation_id, user_id) do nothing
          returning 1`,
    )) as unknown as unknown[];
    return rows.length > 0;
  }

  private async authenticate(
    token: string,
  ): Promise<{ id: string; deviceId: string; tokenEpoch: number } | null> {
    // A bot dials out, like everybody else's bots do.
    if (token.startsWith('yb_')) return this.authenticateBot(token);

    try {
      const { payload } = await jwtVerify(token, secret, {
        issuer: env.JWT_ISSUER,
        algorithms: ['HS256'],
      });

      // Both a full access token and a short-lived gateway ticket are accepted.
      if (payload.typ !== 'access' && payload.typ !== 'gateway') return null;
      if (typeof payload.sub !== 'string' || typeof payload.did !== 'string') return null;

      const [row] = await this.db
        .select({
          userId: users.id,
          tokenEpoch: users.tokenEpoch,
          suspendedUntil: users.suspendedUntil,
          revokedAt: devices.revokedAt,
        })
        .from(users)
        .leftJoin(devices, eq(devices.id, payload.did as string))
        .where(and(eq(users.id, payload.sub), isNull(users.deletedAt)))
        .limit(1);

      if (!row) return null;
      if (row.revokedAt) return null;
      if (row.tokenEpoch !== payload.ep) return null;

      return { id: row.userId, deviceId: payload.did as string, tokenEpoch: row.tokenEpoch };
    } catch {
      return null;
    }
  }

  /**
   * Log a bot in with its own token.
   *
   * Bots could already do everything over REST and could already be reached by
   * webhook, which meant anyone running one at home needed a public HTTPS
   * address for the server to call — a tunnel, or a box somewhere. Every other
   * platform solves this by having the bot dial *out* and hold the connection
   * open, which is exactly what this gateway already does for phones. It only
   * ever refused bots because it had one way to read a token.
   *
   * Nothing downstream changes: a bot is a user row, so it subscribes to the
   * conversations it is a member of through the same query as a person, and
   * receives events through the same fan-out. There is no bot-shaped side
   * channel to keep in step with the real one.
   *
   * The device row exists because presence is keyed by device and a foreign
   * key says so. Its id is the application's, so a bot reconnecting a hundred
   * times is one row and one presence entry rather than a hundred — and the
   * bot shows as online while it holds the socket, which is true.
   *
   * Known limitation, shared with every other kind of session here: the token
   * is checked when the socket opens and not again, so rotating a leaked token
   * stops the next connection rather than the one already open. Killing live
   * sessions on revocation is a mechanism this gateway does not have yet for
   * anybody — `tokenEpoch` has exactly the same hole for people.
   */
  private async authenticateBot(
    token: string,
  ): Promise<{ id: string; deviceId: string; tokenEpoch: number } | null> {
    const hash = createHash('sha256').update(token).digest('hex');

    const [row] = await this.db
      .select({
        applicationId: applications.id,
        botUserId: applications.botUserId,
        tokenEpoch: users.tokenEpoch,
      })
      .from(applications)
      .innerJoin(users, eq(users.id, applications.botUserId))
      .where(
        and(
          eq(applications.tokenHash, hash),
          isNull(applications.revokedAt),
          isNull(users.deletedAt),
        ),
      )
      .limit(1);

    if (!row) return null;

    await this.db
      .insert(devices)
      .values({
        id: row.applicationId,
        userId: row.botUserId,
        platform: 'bot',
        name: 'Gateway connection',
      })
      .onConflictDoNothing();

    // Best-effort, and the same stamp the REST side keeps: an owner looking at
    // the portal should be able to tell a bot that is running from one that
    // has been down for a week.
    void this.db
      .update(applications)
      .set({ lastUsedAt: new Date() })
      .where(eq(applications.id, row.applicationId))
      .catch(() => {});

    return { id: row.botUserId, deviceId: row.applicationId, tokenEpoch: row.tokenEpoch };
  }

  /**
   * READY payload: only what the client does not already have.
   *
   * Conversations whose `message_seq` matches the client's cursor are omitted
   * entirely. This is the difference between a multi-megabyte reconnect and a
   * few kilobytes on an account with hundreds of chats.
   */
  private async buildReady(
    userId: string,
    sessionId: string,
    cursors: Array<{ conversationId: string; seq: number }>,
  ) {
    const cursorMap = new Map(cursors.map((c) => [c.conversationId, c.seq]));

    const rows = await this.db
      .select({
        id: conversations.id,
        type: conversations.type,
        title: conversations.title,
        messageSeq: conversations.messageSeq,
        lastMessageAt: conversations.lastMessageAt,
        lastMessagePreview: conversations.lastMessagePreview,
        memberCount: conversations.memberCount,
        lastReadSeq: ownMembers.lastReadSeq,
        mentionCount: ownMembers.mentionCount,
        notificationLevel: ownMembers.notificationLevel,
        mutedUntil: ownMembers.mutedUntil,
        isPinned: ownMembers.isPinned,
        isArchived: ownMembers.isArchived,
        // A channel with no row of its own inherits the space's mute and
        // notification level, which is what the REST shape does too.
        authorityNotificationLevel: conversationMembers.notificationLevel,
        authorityMutedUntil: conversationMembers.mutedUntil,
      })
      .from(conversations)
      // Membership, resolved through the space for a channel.
      .innerJoin(
        conversationMembers,
        raw`${conversationMembers.conversationId} = coalesce(${conversations.parentId}, ${conversations.id})
            and ${conversationMembers.userId} = ${userId}::uuid
            and ${conversationMembers.leftAt} is null`,
      )
      // State, which a channel only has once it has been written to.
      .leftJoin(
        ownMembers,
        and(eq(ownMembers.conversationId, conversations.id), eq(ownMembers.userId, userId)),
      )
      .where(
        and(
          isNull(conversations.deletedAt),
          // Hidden for this member: the channel's own row wins where it has
          // one, the space's otherwise — the same rule the push worker uses.
          raw`coalesce(${ownMembers.isHidden}, ${conversationMembers.isHidden}, false) = false`,
        ),
      );

    const currentIds = new Set(rows.map((r) => r.id));
    const changed = rows.filter((r) => cursorMap.get(r.id) !== r.messageSeq);

    return {
      sessionId,
      user: { id: userId },
      conversations: changed.map((r) => {
        const lastReadSeq = r.lastReadSeq ?? 0;
        return {
          id: r.id,
          type: r.type,
          title: r.title,
          latestSeq: r.messageSeq,
          lastMessageAt: r.lastMessageAt?.toISOString() ?? null,
          lastMessagePreview: r.lastMessagePreview,
          memberCount: r.memberCount,
          self: {
            lastReadSeq,
            unreadCount: Math.max(0, r.messageSeq - lastReadSeq),
            mentionCount: r.mentionCount ?? 0,
            notificationLevel: r.notificationLevel ?? r.authorityNotificationLevel ?? 'all',
            mutedUntil: (r.mutedUntil ?? r.authorityMutedUntil)?.toISOString() ?? null,
            isPinned: r.isPinned ?? false,
            isArchived: r.isArchived ?? false,
          },
        };
      }),
      removedConversations: [...cursorMap.keys()].filter((id) => !currentIds.has(id)),
      // Too much drift to stream — the client should call POST /v1/sync.
      resyncRequired: changed.length > 200,
      serverTime: new Date().toISOString(),
    };
  }

  async stop(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);

    // Tell every client to reconnect *before* closing, so a rolling deploy
    // reconnects them to the new node instead of leaving them to notice a dead
    // socket on their own.
    for (const session of this.sessions.values()) {
      session.send({ op: GatewayOp.Reconnect });
    }
    await new Promise((r) => setTimeout(r, 250));

    for (const session of this.sessions.values()) session.close(CloseCode.SessionTimeout, 'shutting down');

    await this.presence.stop();
    await this.bus.close();
    this.wss.close();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
    await this.sqlPool.end({ timeout: 5 });
  }
}
