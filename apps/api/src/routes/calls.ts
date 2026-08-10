import {
  and,
  callParticipants,
  calls,
  conversationMembers,
  conversations,
  desc,
  eq,
  inArray,
  isNull,
  media,
  messages,
  ne,
  sql as raw,
  users,
} from '@yappy/db';
import {
  AppError,
  Event,
  ErrorCode,
  Permission,
  callActionBody,
  conflict,
  cursorPagination,
  joinCallBody,
  newId,
  notFound,
  startCallBody,
  unprocessable,
} from '@yappy/shared';
import type { FastifyInstance } from 'fastify';
import { env } from '../env.js';
import { assertCanInitiate, requireMember, requirePermission } from '../lib/access.js';
import { closeRoom, ensureRoom, mintJoinToken, roomNameForCall } from '../lib/livekit.js';
import { toCall, toPublicUser } from '../lib/serialize.js';

/**
 * Calling.
 *
 * Lifecycle: `ringing` → `active` → `ended`. A call goes active on the first
 * join by someone other than the initiator, and ends when the last participant
 * leaves, when everyone declines, or when the ring timeout fires — whichever
 * comes first. The timeout is a scheduled job rather than a client-side timer,
 * because the one client guaranteed not to fire a timer is the one that
 * crashed.
 */
export async function callRoutes(app: FastifyInstance) {
  const hydrate = async (callId: string) => {
    const [call] = await app.db.select().from(calls).where(eq(calls.id, callId)).limit(1);
    if (!call) throw notFound('Call');

    const rows = await app.db
      .select({ participant: callParticipants, user: users, avatarKey: media.objectKey })
      .from(callParticipants)
      .innerJoin(users, eq(users.id, callParticipants.userId))
      .leftJoin(media, eq(media.id, users.avatarMediaId))
      .where(eq(callParticipants.callId, callId));

    return toCall(
      call,
      rows.map((r) => ({
        user: toPublicUser(r.user, r.avatarKey),
        state: r.participant.state,
        isMuted: r.participant.isMuted,
        isVideoEnabled: r.participant.isVideoEnabled,
        isScreenSharing: r.participant.isScreenSharing,
      })),
    );
  };

  // ── Start ─────────────────────────────────────────────────────────────────

  app.post('/', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const body = startCallBody.parse(req.body);
    await app.limiter.consume(`user:${req.user.id}`, 'call.start');

    if (!body.conversationId && body.inviteUserIds.length === 0) {
      throw unprocessable('Provide a conversation or at least one user to call');
    }

    // Double-tapping "call" must not open two rooms.
    const [dupe] = await app.db
      .select({ id: calls.id })
      .from(calls)
      .where(and(eq(calls.initiatorId, req.user.id), eq(calls.nonce, body.nonce)))
      .limit(1);
    if (dupe) return reply.send({ call: await hydrate(dupe.id) });

    let inviteIds: string[] = [];

    if (body.conversationId) {
      const ctx = await requirePermission(
        app.db,
        body.conversationId,
        req.user.id,
        Permission.START_CALL,
      );

      // A call ends by writing a summary card into the conversation, and a
      // space has no timeline to write one into. Voice belongs to a channel,
      // the same way messages do.
      if (ctx.conversation.type === 'space') {
        throw conflict('Start the call in one of this space’s channels');
      }

      // Rejoin semantics: if a call is already live here, join that instead of
      // starting a competing one.
      const [live] = await app.db
        .select({ id: calls.id })
        .from(calls)
        .where(and(eq(calls.conversationId, body.conversationId), ne(calls.state, 'ended')))
        .limit(1);
      if (live) return reply.send({ call: await hydrate(live.id), joined: 'existing' });

      const members = await app.db
        .select({ userId: conversationMembers.userId })
        .from(conversationMembers)
        .where(
          and(
            eq(conversationMembers.conversationId, body.conversationId),
            isNull(conversationMembers.leftAt),
            ne(conversationMembers.userId, req.user.id),
          ),
        )
        .limit(env.CALL_MAX_PARTICIPANTS);

      inviteIds = members.map((m) => m.userId);

      // In a DM, the other side's call privacy applies.
      if (ctx.conversation.type === 'dm' && inviteIds[0]) {
        await assertCanInitiate(app.db, inviteIds[0], req.user.id, 'call');
      }
    } else {
      for (const target of body.inviteUserIds) {
        await assertCanInitiate(app.db, target, req.user.id, 'call');
      }
      inviteIds = body.inviteUserIds;
    }

    const callId = newId();
    const roomName = roomNameForCall(callId);
    const ringExpiresAt = new Date(Date.now() + env.CALL_RING_TIMEOUT_SECONDS * 1000);

    // Before any row exists: a call whose room cannot be created is a call
    // that cannot happen, and failing here is honest — failing later is a
    // phone that rings and then plays nobody.
    try {
      await ensureRoom(roomName);
    } catch (err) {
      req.log.error({ err }, 'livekit room create failed');
      throw new AppError(503, ErrorCode.Unavailable, 'Calls are unavailable right now');
    }

    await app.db.transaction(async (tx) => {
      await tx.insert(calls).values({
        id: callId,
        conversationId: body.conversationId ?? null,
        initiatorId: req.user.id,
        mode: body.mode,
        state: 'ringing',
        roomName,
        nonce: body.nonce,
        maxParticipants: env.CALL_MAX_PARTICIPANTS,
        ringExpiresAt,
      });

      await tx.insert(callParticipants).values([
        {
          callId,
          userId: req.user.id,
          state: 'joined',
          isHost: true,
          isVideoEnabled: body.mode === 'video',
          joinedAt: new Date(),
        },
        ...inviteIds.map((userId) => ({ callId, userId, state: 'ringing' as const })),
      ]);
    });

    const payload = await hydrate(callId);

    // Ring on the user topic, not the conversation topic: a call must reach
    // someone whose app is closed and whose gateway holds no conversation
    // subscriptions yet.
    await app.events.toUsers(inviteIds, Event.CallRing, {
      ...payload,
      expiresAt: ringExpiresAt.toISOString(),
    });

    // VoIP push wakes a killed app so CallKit / ConnectionService can ring.
    // The caller's name rides along because CallKit must draw the incoming-call
    // screen *immediately* from the push alone — a client that has to fetch the
    // call first would miss the reporting deadline and get killed for it.
    await app.enqueue('push.call', {
      callId,
      userIds: inviteIds,
      mode: body.mode,
      callerName: req.user.displayName ?? req.user.username ?? 'Someone',
      conversationId: body.conversationId ?? null,
      expiresAt: ringExpiresAt.toISOString(),
    });
    // Fires only if nobody answers — the handler no-ops on an answered call.
    await app.enqueue('call.ring_timeout', { callId }, { delaySeconds: env.CALL_RING_TIMEOUT_SECONDS });

    const token = await mintJoinToken({
      roomName,
      userId: req.user.id,
      displayName: req.user.displayName ?? req.user.username ?? 'Someone',
      canPublishAudio: true,
      canPublishVideo: body.mode === 'video',
      isHost: true,
    });

    return reply.status(201).send({ call: payload, token, url: env.LIVEKIT_URL });
  });

  // ── Join / decline / leave ────────────────────────────────────────────────

  app.post('/:id/join', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = joinCallBody.parse(req.body);

    const [call] = await app.db.select().from(calls).where(eq(calls.id, id)).limit(1);
    if (!call) throw notFound('Call');
    if (call.state === 'ended') throw unprocessable('This call has ended', ErrorCode.CallAlreadyEnded);

    // Membership is the authorisation for a conversation call; an explicit
    // invite row is the authorisation for an ad-hoc one.
    let isInvited = false;
    if (call.conversationId) {
      await requirePermission(app.db, call.conversationId, req.user.id, Permission.JOIN_CALL);
      isInvited = true;
    } else {
      const [row] = await app.db
        .select({ userId: callParticipants.userId })
        .from(callParticipants)
        .where(and(eq(callParticipants.callId, id), eq(callParticipants.userId, req.user.id)))
        .limit(1);
      isInvited = Boolean(row);
    }
    if (!isInvited) throw notFound('Call');

    const countRows = (await app.db.execute(
      raw`select count(*)::int as count from call_participants
           where call_id = ${id}::uuid and state = 'joined'`,
    )) as unknown as Array<{ count: number }>;
    const count = countRows[0]?.count ?? 0;
    if (count >= call.maxParticipants) throw unprocessable('This call is full', ErrorCode.CallFull);

    const now = new Date();
    await app.db.transaction(async (tx) => {
      await tx
        .insert(callParticipants)
        .values({
          callId: id,
          userId: req.user.id,
          state: 'joined',
          // A bot authenticates with an application id, not a device row —
          // storing it here would break the foreign key.
          deviceId: req.application ? null : (body.deviceId ?? req.deviceId),
          isVideoEnabled: body.publishVideo,
          joinedAt: now,
        })
        .onConflictDoUpdate({
          target: [callParticipants.callId, callParticipants.userId],
          set: {
            state: 'joined',
            // A bot authenticates with an application id, not a device row —
          // storing it here would break the foreign key.
          deviceId: req.application ? null : (body.deviceId ?? req.deviceId),
            isVideoEnabled: body.publishVideo,
            joinedAt: now,
            leftAt: null,
          },
        });

      if (call.state === 'ringing') {
        await tx
          .update(calls)
          .set({ state: 'active', startedAt: now, ringExpiresAt: null })
          .where(eq(calls.id, id));
      }
      await tx
        .update(calls)
        .set({ peakParticipants: raw`greatest(${calls.peakParticipants}, ${count + 1})` })
        .where(eq(calls.id, id));
    });

    // Insurance: LiveKit collects empty rooms after five minutes, and a
    // rejoin into a collected room must recreate it rather than 404.
    try {
      await ensureRoom(call.roomName);
    } catch (err) {
      req.log.warn({ err }, 'livekit room ensure failed on join');
    }

    const token = await mintJoinToken({
      roomName: call.roomName,
      userId: req.user.id,
      displayName: req.user.displayName ?? req.user.username ?? 'Someone',
      canPublishAudio: body.publishAudio,
      canPublishVideo: body.publishVideo || call.mode === 'video',
      isHost: call.initiatorId === req.user.id,
    });

    const payload = await hydrate(id);
    await broadcastCall(app, call.conversationId, id, Event.CallUpdate, payload);

    // Every other device of this user must stop ringing.
    await app.events.toUser(req.user.id, Event.CallParticipantUpdate, {
      callId: id,
      userId: req.user.id,
      state: 'joined',
      answeredOn: req.deviceId,
    });

    return reply.send({ call: payload, token, url: env.LIVEKIT_URL });
  });

  app.post('/:id/decline', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = callActionBody.parse(req.body ?? {});

    const [call] = await app.db.select().from(calls).where(eq(calls.id, id)).limit(1);
    if (!call) throw notFound('Call');

    await app.db
      .update(callParticipants)
      .set({ state: body.reason === 'busy' ? 'busy' : 'declined', leftAt: new Date() })
      .where(and(eq(callParticipants.callId, id), eq(callParticipants.userId, req.user.id)));

    await app.events.toUser(req.user.id, Event.CallParticipantUpdate, {
      callId: id,
      userId: req.user.id,
      state: 'declined',
    });
    await broadcastCall(app, call.conversationId, id, Event.CallParticipantUpdate, {
      callId: id,
      userId: req.user.id,
      state: 'declined',
    });

    // A 1:1 call where the callee declines is over — do not leave the caller
    // listening to a ring nobody will answer.
    const remainingRows = (await app.db.execute(
      raw`select count(*)::int as remaining from call_participants
           where call_id = ${id}::uuid and state in ('ringing', 'invited', 'joined')
             and user_id <> ${call.initiatorId}::uuid`,
    )) as unknown as Array<{ remaining: number }>;

    if ((remainingRows[0]?.remaining ?? 0) === 0) await endCall(app, id, 'declined');

    return reply.send({ ok: true });
  });

  app.post('/:id/leave', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };

    const [participant] = await app.db
      .select()
      .from(callParticipants)
      .where(and(eq(callParticipants.callId, id), eq(callParticipants.userId, req.user.id)))
      .limit(1);
    if (!participant) throw notFound('Call');

    const now = new Date();
    const seconds = participant.joinedAt
      ? Math.round((now.getTime() - participant.joinedAt.getTime()) / 1000)
      : 0;

    await app.db
      .update(callParticipants)
      .set({
        state: 'left',
        leftAt: now,
        totalSeconds: participant.totalSeconds + seconds,
      })
      .where(and(eq(callParticipants.callId, id), eq(callParticipants.userId, req.user.id)));

    const [call] = await app.db.select().from(calls).where(eq(calls.id, id)).limit(1);

    const activeRows = (await app.db.execute(
      raw`select count(*)::int as active from call_participants
           where call_id = ${id}::uuid and state = 'joined'`,
    )) as unknown as Array<{ active: number }>;
    const active = activeRows[0]?.active ?? 0;

    if (active === 0) {
      await endCall(app, id, 'hangup');
    } else {
      await broadcastCall(app, call?.conversationId ?? null, id, Event.CallParticipantUpdate, {
        callId: id,
        userId: req.user.id,
        state: 'left',
      });
    }

    return reply.send({ ok: true, callEnded: active === 0 });
  });

  app.post('/:id/end', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const [call] = await app.db.select().from(calls).where(eq(calls.id, id)).limit(1);
    if (!call) throw notFound('Call');

    const isInitiator = call.initiatorId === req.user.id;
    if (!isInitiator && call.conversationId) {
      await requirePermission(app.db, call.conversationId, req.user.id, Permission.END_CALL_FOR_ALL);
    } else if (!isInitiator) {
      throw conflict('Only the caller can end this call');
    }

    await endCall(app, id, 'ended_by_host');
    return reply.send({ ok: true });
  });

  /** Mic/camera/screen-share state, mirrored so the UI agrees before media does. */
  app.patch('/:id/state', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { isMuted?: boolean; isVideoEnabled?: boolean; isScreenSharing?: boolean };

    const [updated] = await app.db
      .update(callParticipants)
      .set({
        ...(body.isMuted !== undefined ? { isMuted: body.isMuted } : {}),
        ...(body.isVideoEnabled !== undefined ? { isVideoEnabled: body.isVideoEnabled } : {}),
        ...(body.isScreenSharing !== undefined ? { isScreenSharing: body.isScreenSharing } : {}),
      })
      .where(and(eq(callParticipants.callId, id), eq(callParticipants.userId, req.user.id)))
      .returning();
    if (!updated) throw notFound('Call');

    const [call] = await app.db.select({ conversationId: calls.conversationId }).from(calls).where(eq(calls.id, id)).limit(1);
    await broadcastCall(app, call?.conversationId ?? null, id, Event.CallParticipantUpdate, {
      callId: id,
      userId: req.user.id,
      isMuted: updated.isMuted,
      isVideoEnabled: updated.isVideoEnabled,
      isScreenSharing: updated.isScreenSharing,
    });

    return reply.send({ ok: true });
  });

  app.get('/:id', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    return reply.send({ call: await hydrate(id) });
  });

  /** Call history, for the "Calls" tab. */
  app.get('/', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { limit, cursor } = cursorPagination.parse(req.query);

    const rows = await app.db
      .select({ call: calls, myState: callParticipants.state })
      .from(callParticipants)
      .innerJoin(calls, eq(calls.id, callParticipants.callId))
      .where(
        and(
          eq(callParticipants.userId, req.user.id),
          cursor ? raw`${calls.createdAt} < ${cursor}::timestamptz` : undefined,
        ),
      )
      .orderBy(desc(calls.createdAt))
      .limit(limit);

    return reply.send({
      calls: rows.map((r) => ({
        id: r.call.id,
        conversationId: r.call.conversationId,
        initiatorId: r.call.initiatorId,
        mode: r.call.mode,
        state: r.call.state,
        myState: r.myState,
        durationSeconds: r.call.durationSeconds,
        endReason: r.call.endReason,
        createdAt: r.call.createdAt.toISOString(),
      })),
      nextCursor: rows.length === limit ? (rows.at(-1)?.call.createdAt.toISOString() ?? null) : null,
    });
  });
}

/** Broadcast to the conversation when there is one, else to the participants. */
async function broadcastCall(
  app: FastifyInstance,
  conversationId: string | null,
  callId: string,
  event: (typeof Event)[keyof typeof Event],
  payload: unknown,
) {
  if (conversationId) {
    await app.events.toConversation(conversationId, event, payload);
    return;
  }
  const rows = await app.db
    .select({ userId: callParticipants.userId })
    .from(callParticipants)
    .where(eq(callParticipants.callId, callId));
  await app.events.toUsers(
    rows.map((r) => r.userId),
    event,
    payload,
  );
}

/**
 * End a call and write the summary card into the conversation.
 *
 * Exported so the ring-timeout worker can call it: the timeout path and the
 * hangup path must produce identical state, and duplicating this logic is how
 * they drift.
 */
export async function endCall(app: FastifyInstance, callId: string, reason: string): Promise<void> {
  const [call] = await app.db.select().from(calls).where(eq(calls.id, callId)).limit(1);
  if (!call || call.state === 'ended') return;

  const now = new Date();
  const durationSeconds = call.startedAt ? Math.round((now.getTime() - call.startedAt.getTime()) / 1000) : 0;

  const participants = await app.db
    .select()
    .from(callParticipants)
    .where(eq(callParticipants.callId, callId));

  await app.db.transaction(async (tx) => {
    await tx
      .update(calls)
      .set({ state: 'ended', endedAt: now, endReason: reason, durationSeconds })
      .where(eq(calls.id, callId));

    // Anyone still ringing when the call ends missed it.
    await tx
      .update(callParticipants)
      .set({ state: 'missed', leftAt: now })
      .where(and(eq(callParticipants.callId, callId), inArray(callParticipants.state, ['ringing', 'invited'])));

    await tx
      .update(callParticipants)
      .set({ state: 'left', leftAt: now })
      .where(and(eq(callParticipants.callId, callId), eq(callParticipants.state, 'joined')));

    // The call becomes a message so it appears in the thread like everything
    // else, and so "missed call" is something you can scroll back to.
    if (call.conversationId) {
      const outcome =
        durationSeconds > 0
          ? 'completed'
          : reason === 'declined'
            ? 'declined'
            : reason === 'timeout'
              ? 'missed'
              : 'cancelled';

      const seqRows = (await tx.execute(
        raw`select allocate_message_seq(${call.conversationId}::uuid) as seq`,
      )) as unknown as Array<{ seq: string | number }>;

      const messageId = newId();
      await tx.insert(messages).values({
        id: messageId,
        conversationId: call.conversationId,
        seq: Number(seqRows[0]!.seq),
        senderId: call.initiatorId,
        type: 'call',
        callSummary: {
          callId,
          mode: call.mode as 'audio' | 'video',
          outcome,
          durationSeconds,
          participantIds: participants.filter((p) => p.joinedAt).map((p) => p.userId),
        },
      });

      await tx
        .update(conversations)
        .set({
          lastMessageId: messageId,
          lastMessageAt: now,
          lastMessagePreview: outcome === 'missed' ? '📞 Missed call' : '📞 Call',
        })
        .where(eq(conversations.id, call.conversationId));
    }
  });

  await closeRoom(call.roomName);

  const payload = { callId, state: 'ended', endReason: reason, durationSeconds };
  if (call.conversationId) {
    await app.events.toConversation(call.conversationId, Event.CallEnd, payload);
  }
  await app.events.toUsers(
    participants.map((p) => p.userId),
    Event.CallEnd,
    payload,
  );
}
