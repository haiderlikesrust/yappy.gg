import { createServer, type IncomingMessage, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { uuidv7 } from 'uuidv7';
import { jwtVerify } from 'jose';
import {
  PgBus,
  and,
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

    const memberships = await this.db
      .select({ conversationId: conversationMembers.conversationId })
      .from(conversationMembers)
      .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
      .where(
        and(
          eq(conversationMembers.userId, auth.id),
          isNull(conversationMembers.leftAt),
          isNull(conversations.deletedAt),
        ),
      );

    await this.subscriptions.addConversations(
      session,
      memberships.map((m) => m.conversationId),
    );

    await this.presence.connect(auth.deviceId, auth.id, parsed.data.presence ?? 'online');
    session.presence = parsed.data.presence ?? 'online';

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
    // Subscriptions are NOT dropped here — the session is parked and may resume
    // within the window. They go when `sweep()` reaps it.
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

      case CommandName.ReadAck: {
        if (!session.conversations.has(command.conversationId)) {
          ack({ ok: false, error: 'not_a_member' });
          return;
        }
        // Monotonic and clamped to the conversation head in one statement, so
        // two devices acking out of order cannot move the cursor backwards.
        const rows = (await this.db.execute(
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
            seq: row.last_read_seq,
            readAt: new Date().toISOString(),
          },
          exclude: [session.user.id],
        });

        ack({
          ok: true,
          lastReadSeq: row.last_read_seq,
          unreadCount: Math.max(0, row.message_seq - row.last_read_seq),
          mentionCount: row.mention_count,
        });
        return;
      }

      case CommandName.PresenceUpdate: {
        session.presence = command.status;
        await this.presence.setStatus(session.user.deviceId, command.status);
        await this.bus.publish(`u_${session.user.id.replace(/-/g, '')}`, {
          t: Event.PresenceUpdate,
          d: { userId: session.user.id, status: command.status, customStatus: command.customStatus ?? null },
        });
        ack();
        return;
      }

      case CommandName.Subscribe: {
        // Only for conversations the user is actually in — the gateway is not
        // a place to widen access.
        const [member] = await this.db
          .select({ userId: conversationMembers.userId })
          .from(conversationMembers)
          .where(
            and(
              eq(conversationMembers.conversationId, command.conversationId),
              eq(conversationMembers.userId, session.user.id),
              isNull(conversationMembers.leftAt),
            ),
          )
          .limit(1);
        if (!member) {
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
        const rows = (await this.db.execute(
          raw`select distinct p.user_id, p.status
                from presence p
                join conversation_members m
                  on m.user_id = p.user_id
                 and m.conversation_id = ${command.conversationId}::uuid
                 and m.left_at is null
               where p.expires_at > now()`,
        )) as unknown as Array<{ user_id: string; status: string }>;
        ack({ ok: true, online: rows.map((r) => ({ userId: r.user_id, status: r.status })) });
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
        for (const userId of recipients) {
          if (userId === session.user.id) continue;
          await this.bus.publish(`u_${userId.replace(/-/g, '')}`, {
            t: Event.CallSignal,
            d: { callId: command.callId, from: session.user.id, payload: command.payload },
          });
        }
        ack();
        return;
      }
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async authenticate(
    token: string,
  ): Promise<{ id: string; deviceId: string; tokenEpoch: number } | null> {
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
        lastReadSeq: conversationMembers.lastReadSeq,
        mentionCount: conversationMembers.mentionCount,
        notificationLevel: conversationMembers.notificationLevel,
        mutedUntil: conversationMembers.mutedUntil,
        isPinned: conversationMembers.isPinned,
        isArchived: conversationMembers.isArchived,
      })
      .from(conversationMembers)
      .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
      .where(
        and(
          eq(conversationMembers.userId, userId),
          isNull(conversationMembers.leftAt),
          isNull(conversations.deletedAt),
        ),
      );

    const currentIds = new Set(rows.map((r) => r.id));
    const changed = rows.filter((r) => cursorMap.get(r.id) !== r.messageSeq);

    return {
      sessionId,
      user: { id: userId },
      conversations: changed.map((r) => ({
        id: r.id,
        type: r.type,
        title: r.title,
        latestSeq: r.messageSeq,
        lastMessageAt: r.lastMessageAt?.toISOString() ?? null,
        lastMessagePreview: r.lastMessagePreview,
        memberCount: r.memberCount,
        self: {
          lastReadSeq: r.lastReadSeq,
          unreadCount: Math.max(0, r.messageSeq - r.lastReadSeq),
          mentionCount: r.mentionCount,
          notificationLevel: r.notificationLevel ?? 'all',
          mutedUntil: r.mutedUntil?.toISOString() ?? null,
          isPinned: r.isPinned,
          isArchived: r.isArchived,
        },
      })),
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
