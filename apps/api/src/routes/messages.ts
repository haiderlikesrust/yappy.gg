import {
  and,
  conversationMembers,
  conversations,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  media,
  messageAttachments,
  messageReactions,
  messages,
  pinnedMessages,
  savedMessages,
  pollOptions,
  polls,
  pollVotes,
  sql as raw,
  users,
} from '@yappy/db';
import {
  Event,
  LIMITS,
  Permission,
  conflict,
  deleteMessageQuery,
  editMessageBody,
  forbidden,
  forwardMessagesBody,
  interactionResponse,
  messageHistoryQuery,
  newId,
  notFound,
  pollVoteBody,
  reactionBody,
  readAckBody,
  has,
  sendMessageBody,
  unprocessable,
} from '@yappy/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { materialiseChannelMember, requireMember, requirePermission } from '../lib/access.js';
import { txExecutor } from '../lib/events.js';
import { notDeletedForViewer } from '../lib/hidden.js';
import { applyResponse as applyInteractionResponse, pressButton } from '../lib/interactions.js';
import { TRANSLATE_MAX_CHARS, translateText, translationAvailable } from '../lib/translate.js';
import { fanoutMessageToBots } from '../lib/webhooks.js';
import { getYapperUserId, handleYapperMessage } from '../lib/yapper.js';
import { mediaUrl, toMember, toPublicUser } from '../lib/serialize.js';

const pressBody = z.object({ customId: z.string().min(1).max(100) });

/**
 * Messages and everything attached to one: reactions, pins, polls, read state.
 *
 * Mounted under /conversations so the URL reflects the ownership — a message id
 * is only meaningful inside its conversation, and routing it that way means the
 * membership check happens before anything else.
 */
export async function messageRoutes(app: FastifyInstance) {
  // ── History & send ────────────────────────────────────────────────────────

  app.get('/:id/messages', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = messageHistoryQuery.parse(req.query);
    return reply.send(await app.messages.history(req.user.id, id, query));
  });

  app.post('/:id/messages', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = sendMessageBody.parse(req.body);
    await app.limiter.consume(`user:${req.user.id}`, 'message.send');

    const result = await app.messages.send(req.user.id, id, body);

    // yapper answers out of band. Deliberately not awaited: the sender's
    // message is already accepted, and making them wait on a bot — or fail
    // because one did — would be the wrong trade. Errors are logged inside.
    //
    // Every text message is offered, not only ones starting with a slash: the
    // sign-in flow asks a question and the answer is a bare code. The handler
    // rejects anything outside a DM with yapper on a cached lookup.
    // Text as before, and now image messages too — a custom sticker is made by
    // sending yapper a picture mid-`/stickerpack`. The handler rejects anything
    // that is not the yapper DM (or a pending flow) on a cached lookup, so this
    // stays cheap for the common case.
    const attachmentIds = (body as { attachmentIds?: string[] }).attachmentIds;
    const offerToYapper =
      result.created &&
      ((body.content && (body.type ?? 'text') === 'text') || (attachmentIds?.length ?? 0) > 0);
    if (offerToYapper) {
      void handleYapperMessage(app, {
        conversationId: id,
        senderId: req.user.id,
        content: body.content ?? null,
        attachmentIds,
        // So a group mention of @yapper is recognised by entity, not just text.
        entities: (body as { entities?: Array<{ type: string; userId?: string }> }).entities,
        messageId: result.message.id,
      })
        .then(async (botReply) => {
          if (!botReply) return;
          const botId = await getYapperUserId(app);
          if (!botId) return;
          await app.messages.send(botId, id, {
            nonce: `yapper_${result.message.id}`,
            type: botReply.poll ? 'poll' : 'text',
            content: botReply.content,
            embeds: botReply.embeds,
            components: botReply.components,
            replyToId: botReply.replyToId ?? null,
            // This call skips the zod parse, so the schema's defaults never
            // ran — fill the fields the poll insert reads directly.
            poll: botReply.poll ? { ...botReply.poll, anonymous: false, closesAt: null } : undefined,
            silent: false,
          } as never);
        })
        .catch((err) => app.log.error({ err }, 'yapper reply failed'));
    }

    // Webhook bots hear about the message the same way — after the send, off
    // the request path, with pg-boss carrying the retries.
    if (result.created) {
      void fanoutMessageToBots(app, id, result.message, req.user.id).catch((err) =>
        app.log.warn({ err }, 'bot webhook fanout failed'),
      );
    }

    // 200 rather than 201 on an idempotent replay, so the client can tell a
    // retry from a genuine new send.
    return reply.status(result.created ? 201 : 200).send({ message: result.message });
  });

  app.get('/:id/messages/:messageId', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { messageId } = req.params as { messageId: string };
    return reply.send({ message: await app.messages.get(req.user.id, messageId) });
  });

  app.patch('/:id/messages/:messageId', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { messageId } = req.params as { messageId: string };
    const body = editMessageBody.parse(req.body);
    await app.limiter.consume(`user:${req.user.id}`, 'message.edit');
    return reply.send({
      message: await app.messages.edit(req.user.id, messageId, body.content ?? null, body.entities),
    });
  });

  app.delete('/:id/messages/:messageId', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { messageId } = req.params as { messageId: string };
    const { forEveryone } = deleteMessageQuery.parse(req.query);
    await app.limiter.consume(`user:${req.user.id}`, 'message.delete');
    return reply.send(await app.messages.remove(req.user.id, messageId, forEveryone));
  });

  /** Thread view: every reply under one root, oldest first. */
  app.get('/:id/messages/:messageId/thread', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id, messageId } = req.params as { id: string; messageId: string };
    const { limit, after } = messageHistoryQuery.parse(req.query);
    await requirePermission(app.db, id, req.user.id, Permission.READ_HISTORY);

    const rows = await app.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, id),
          eq(messages.threadRootId, messageId),
          isNull(messages.deletedAt),
          notDeletedForViewer(req.user.id),
          after !== undefined ? raw`${messages.seq} > ${after}` : undefined,
        ),
      )
      .orderBy(messages.seq)
      .limit(limit);

    return reply.send({
      messages: await app.messages.hydrateMany(rows, req.user.id),
      hasMore: rows.length === limit,
    });
  });

  // ── Saved messages (personal bookmarks) ───────────────────────────────────
  // The bookmark is the viewer's, not the conversation's: no event fans out,
  // nobody else can see it, and the list lives under /users/me/saved.

  app.put('/:id/messages/:messageId/save', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id, messageId } = req.params as { id: string; messageId: string };
    await app.limiter.consume(`user:${req.user.id}`, 'message.save');
    await requireMember(app.db, id, req.user.id);

    const [msg] = await app.db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.id, messageId),
          eq(messages.conversationId, id),
          isNull(messages.deletedAt),
          notDeletedForViewer(req.user.id),
        ),
      )
      .limit(1);
    if (!msg) throw notFound('Message');

    await app.db
      .insert(savedMessages)
      .values({ userId: req.user.id, messageId })
      .onConflictDoNothing();
    return reply.send({ saved: true });
  });

  app.delete('/:id/messages/:messageId/save', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { messageId } = req.params as { messageId: string };
    await app.db
      .delete(savedMessages)
      .where(and(eq(savedMessages.userId, req.user.id), eq(savedMessages.messageId, messageId)));
    return reply.send({ saved: false });
  });

  // ── Translation ───────────────────────────────────────────────────────────

  /**
   * Translate one message for the requester. Nothing is stored and nothing
   * fans out — the translation goes back to the person who asked and
   * evaporates. Costs a model call, hence the tight per-user bucket.
   */
  app.post('/:id/messages/:messageId/translate', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id, messageId } = req.params as { id: string; messageId: string };
    const { to } = z
      .object({ to: z.string().trim().min(2).max(48).optional() })
      .parse(req.body ?? {});
    if (!translationAvailable()) {
      throw unprocessable('Translation is not set up on this server');
    }
    await app.limiter.consume(`user:${req.user.id}`, 'message.translate');
    await requireMember(app.db, id, req.user.id);

    const [msg] = await app.db
      .select({ content: messages.content })
      .from(messages)
      .where(
        and(
          eq(messages.id, messageId),
          eq(messages.conversationId, id),
          isNull(messages.deletedAt),
          notDeletedForViewer(req.user.id),
        ),
      )
      .limit(1);
    if (!msg) throw notFound('Message');
    if (!msg.content?.trim()) throw unprocessable('Nothing to translate');

    const result = await translateText(msg.content.slice(0, TRANSLATE_MAX_CHARS), to ?? 'English');
    if (!result) throw unprocessable('Translation failed — try again in a moment');
    return reply.send(result);
  });

  /**
   * Forwarding.
   *
   * Implemented as a fresh send into each target rather than a pointer to the
   * original: the original may later be deleted, and a forwarded copy that
   * vanishes from an unrelated conversation is surprising. Attribution is kept
   * on the copy unless the sender opts out.
   */
  app.post('/messages/forward', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const body = forwardMessagesBody.parse(req.body);
    await app.limiter.consume(`user:${req.user.id}`, 'message.forward', body.toConversationIds.length);

    const sources = await app.db
      .select()
      .from(messages)
      // Not forwardable if you deleted it for yourself: it is gone from your
      // timeline, and being able to re-broadcast it from a menu you cannot see
      // is a contradiction.
      .where(
        and(
          inArray(messages.id, body.messageIds),
          isNull(messages.deletedAt),
          notDeletedForViewer(req.user.id),
        ),
      );

    if (sources.length === 0) throw notFound('Message');

    // You can only forward out of conversations you can read.
    for (const conversationId of [...new Set(sources.map((s) => s.conversationId))]) {
      await requirePermission(app.db, conversationId, req.user.id, Permission.READ_HISTORY);
    }

    const attachmentRows = await app.db
      .select({
        messageId: messageAttachments.messageId,
        mediaId: messageAttachments.mediaId,
        position: messageAttachments.position,
      })
      .from(messageAttachments)
      .where(inArray(messageAttachments.messageId, body.messageIds))
      .orderBy(messageAttachments.position);

    const attachmentsBySource = new Map<string, string[]>();
    for (const a of attachmentRows) {
      const list = attachmentsBySource.get(a.messageId) ?? [];
      list.push(a.mediaId);
      attachmentsBySource.set(a.messageId, list);
    }

    const results: Array<{ conversationId: string; messageIds: string[] }> = [];

    for (const targetId of body.toConversationIds) {
      const created: string[] = [];
      const ordered = body.messageIds
        .map((id) => sources.find((s) => s.id === id))
        .filter((s): s is (typeof sources)[number] => Boolean(s));

      for (const source of ordered) {
        const sent = await app.messages.send(req.user.id, targetId, {
          nonce: `fwd_${source.id}_${targetId}`.slice(0, 64),
          type: source.type === 'system' || source.type === 'call' ? 'text' : source.type,
          content: source.content,
          entities: (source.entities ?? undefined) as never,
          // The media rows are shared; ref-counting keeps them alive as long as
          // any copy references them.
          attachmentIds: attachmentsBySource.get(source.id),
          stickerId: source.stickerId,
          gif: source.gif as never,
          location: source.location as never,
          contact: source.contact as never,
          silent: false,
          // In the insert, not patched in afterwards: the gateway event fires
          // inside the send, and attribution added later reached nobody live.
          forwardedFrom:
            !body.hideSender && source.senderId
              ? { messageId: source.id, userId: source.senderId }
              : null,
        } as never);
        created.push(sent.message.id);
      }

      if (body.comment) {
        await app.messages.send(req.user.id, targetId, {
          nonce: `fwdc_${newId()}`.slice(0, 64),
          type: 'text',
          content: body.comment,
          silent: false,
        } as never);
      }

      results.push({ conversationId: targetId, messageIds: created });
    }

    return reply.status(201).send({ forwarded: results });
  });

  // ── Read state ────────────────────────────────────────────────────────────

  /**
   * Read acknowledgement.
   *
   * Monotonic: a cursor never moves backwards, because two devices ack out of
   * order all the time and the lower one must not resurrect unread badges.
   */
  app.post('/:id/read', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { seq } = readAckBody.parse(req.body);
    const ctx = await requireMember(app.db, id, req.user.id);

    if (seq <= ctx.member.lastReadSeq) {
      return reply.send({ lastReadSeq: ctx.member.lastReadSeq, unreadCount: Math.max(0, ctx.conversation.messageSeq - ctx.member.lastReadSeq) });
    }

    const capped = Math.min(seq, ctx.conversation.messageSeq);
    if (ctx.memberIsVirtual) await materialiseChannelMember(app.db, id, req.user.id);
    const [updated] = await app.db
      .update(conversationMembers)
      .set({
        lastReadSeq: capped,
        lastDeliveredSeq: raw`greatest(${conversationMembers.lastDeliveredSeq}, ${capped})`,
        lastReadAt: new Date(),
      })
      .where(
        and(eq(conversationMembers.conversationId, id), eq(conversationMembers.userId, req.user.id)),
      )
      .returning();

    // Other members see the receipt only if this user has receipts enabled.
    if (req.user.privacy.readReceipts) {
      await app.events.toConversation(id, Event.ReadReceipt, {
        conversationId: id,
        userId: req.user.id,
        seq: capped,
        readAt: new Date().toISOString(),
      });
    }
    // The user's own devices always sync, receipts setting or not.
    await app.events.toUser(req.user.id, Event.ConversationStateUpdate, {
      conversationId: id,
      lastReadSeq: capped,
      unreadCount: Math.max(0, ctx.conversation.messageSeq - capped),
      mentionCount: updated!.mentionCount,
    });

    return reply.send({
      lastReadSeq: capped,
      unreadCount: Math.max(0, ctx.conversation.messageSeq - capped),
      mentionCount: updated!.mentionCount,
    });
  });

  /** Who has read up to where — the "seen by" sheet in a group. */
  app.get('/:id/receipts', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { seq } = req.query as { seq?: string };
    await requireMember(app.db, id, req.user.id);

    const target = seq ? Number(seq) : 0;
    const rows = await app.db
      .select({
        member: conversationMembers,
        user: users,
        avatarKey: media.objectKey,
      })
      .from(conversationMembers)
      .innerJoin(users, eq(users.id, conversationMembers.userId))
      .leftJoin(media, eq(media.id, users.avatarMediaId))
      .where(
        and(
          eq(conversationMembers.conversationId, id),
          isNull(conversationMembers.leftAt),
          raw`${conversationMembers.lastReadSeq} >= ${target}`,
          // Someone who disabled read receipts is not listed.
          raw`${users.privacy} ->> 'readReceipts' = 'true'`,
        ),
      )
      .limit(200);

    return reply.send({
      readBy: rows.map((r) => ({
        user: toPublicUser(r.user, r.avatarKey),
        seq: r.member.lastReadSeq,
        readAt: r.member.lastReadAt?.toISOString() ?? null,
        // The grey-tick watermark, alongside the read one. With seq=0 this
        // endpoint returns every receipt-visible member, which is exactly the
        // snapshot a chat needs to draw ticks without waiting for live events.
        deliveredSeq: r.member.lastDeliveredSeq,
      })),
    });
  });

  // ── Reactions ─────────────────────────────────────────────────────────────

  app.put('/:id/messages/:messageId/reactions', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id, messageId } = req.params as { id: string; messageId: string };
    const body = reactionBody.parse(req.body);
    await requirePermission(app.db, id, req.user.id, Permission.ADD_REACTIONS);
    await app.limiter.consume(`user:${req.user.id}`, 'reaction.add');

    const key = body.emoji ?? `sticker:${body.stickerId}`;

    const [message] = await app.db
      .select({ id: messages.id, conversationId: messages.conversationId, reactionCounts: messages.reactionCounts, deletedAt: messages.deletedAt })
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1);
    if (!message || message.conversationId !== id) throw notFound('Message');
    if (message.deletedAt) throw unprocessable('Cannot react to a deleted message');

    const distinct = Object.keys(message.reactionCounts);
    if (!distinct.includes(key) && distinct.length >= LIMITS.reactionsPerMessage) {
      throw conflict('This message has too many different reactions');
    }

    await app.db
      .insert(messageReactions)
      .values({ messageId, userId: req.user.id, emoji: key })
      .onConflictDoNothing();

    await app.events.toConversation(id, Event.ReactionAdd, {
      conversationId: id,
      messageId,
      userId: req.user.id,
      emoji: key,
    });

    await app.enqueue('push.reaction', { messageId, actorId: req.user.id, emoji: key });

    return reply.send({ ok: true });
  });

  app.delete('/:id/messages/:messageId/reactions', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id, messageId } = req.params as { id: string; messageId: string };
    const { emoji, stickerId } = req.query as { emoji?: string; stickerId?: string };
    const key = emoji ?? (stickerId ? `sticker:${stickerId}` : null);
    if (!key) throw unprocessable('emoji or stickerId is required');

    await requireMember(app.db, id, req.user.id);
    await app.db
      .delete(messageReactions)
      .where(
        and(
          eq(messageReactions.messageId, messageId),
          eq(messageReactions.userId, req.user.id),
          eq(messageReactions.emoji, key),
        ),
      );

    await app.events.toConversation(id, Event.ReactionRemove, {
      conversationId: id,
      messageId,
      userId: req.user.id,
      emoji: key,
    });

    return reply.send({ ok: true });
  });

  /** Who reacted with what — the reaction detail sheet. */
  /**
   * Slash commands offered here, contributed by whichever bots are present.
   *
   * Served from each bot's declared list rather than asked of the bot live:
   * the composer needs an answer on the first keystroke after "/", and a bot
   * that is slow or asleep must not make typing feel broken.
   *
   * Resolved through the parent for a channel, because that is where a space's
   * members — bots included — actually live.
   */
  app.get('/:id/commands', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const ctx = await requireMember(app.db, id, req.user.id);

    const rows = (await app.db.execute(raw`
      select u.id as bot_id, u.username as bot_username, md.object_key as avatar_key, a.commands
        from conversations c
        join conversation_members m
          on m.conversation_id = coalesce(c.parent_id, c.id) and m.left_at is null
        join users u on u.id = m.user_id and u.is_bot and u.deleted_at is null
        join applications a on a.bot_user_id = u.id and a.revoked_at is null
        left join media md on md.id = u.avatar_media_id
       where c.id = ${id}::uuid
    `)) as unknown as Array<{
      bot_id: string;
      bot_username: string | null;
      avatar_key: string | null;
      commands: unknown;
    }>;

    type DeclaredCommand = {
      name: string;
      description?: string;
      usage?: string;
      requiredPermissions?: string;
      staffOnly?: boolean;
      context?: 'dm' | 'group' | 'all';
    };

    const isDm = ctx.conversation.type === 'dm';
    const commands = rows.flatMap((row) =>
      ((row.commands as DeclaredCommand[]) ?? [])
        // Discord's default_member_permissions, enforced at the source: a
        // command the member could not invoke is never offered to them, so a
        // group's /ban simply does not exist in a regular member's
        // autocomplete. Gates, not styling — the same fields are checked
        // again when a button is pressed.
        .filter((c) => !c.staffOnly || req.user.isStaff)
        // Same idea for surface: a DM-only command in a group composer is an
        // invitation to run a private flow in front of the whole room.
        .filter((c) => {
          const context = c.context ?? 'all';
          return context === 'all' || (context === 'dm') === isDm;
        })
        .filter((c) => {
          if (!c.requiredPermissions) return true;
          try {
            return has(ctx.permissions, BigInt(c.requiredPermissions));
          } catch {
            return false;
          }
        })
        .map((c) => ({
          name: c.name,
          description: c.description ?? '',
          usage: c.usage ?? `/${c.name}`,
          botId: row.bot_id,
          botUsername: row.bot_username,
          // So a picker with several bots can say whose command each one is.
          botAvatarUrl: row.avatar_key ? mediaUrl(row.avatar_key) : null,
        })),
    );

    return reply.send({ commands });
  });

  /**
   * A member's effective permissions here, as a decimal bitfield.
   *
   * This is the primitive that lets a bot do the right thing: before acting
   * on "/ban @troll" it asks what the *invoker* may do, not what it may do
   * itself. Any member may ask about any member — the answer is visible in
   * the roles UI anyway, and hiding it from bots only guarantees they skip
   * the check.
   */
  app.get('/:id/members/:userId/permissions', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id, userId } = req.params as { id: string; userId: string };
    await requireMember(app.db, id, req.user.id);
    const target = await requireMember(app.db, id, userId);

    const [flags] = await app.db
      .select({ isStaff: users.isStaff })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    return reply.send({
      userId,
      permissions: target.permissions.toString(),
      isStaff: Boolean(flags?.isStaff),
    });
  });

  /**
   * Press a button on a bot's message.
   *
   * Rate-limited as a write rather than a read: a press causes the bot to act,
   * and the cheapest denial-of-service against a bot would otherwise be
   * hammering one of its buttons.
   */
  app.post('/:id/messages/:messageId/interactions', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id, messageId } = req.params as { id: string; messageId: string };
    const { customId } = pressBody.parse(req.body);
    await app.limiter.consume(`user:${req.user.id}`, 'message.send');

    const message = await pressButton(app, {
      actorId: req.user.id,
      conversationId: id,
      messageId,
      customId,
    });

    return reply.send({ message });
  });

  /**
   * A bot's answer to a press it received over the socket.
   *
   * A webhook bot answers in the body of the delivery it was sent. A bot on
   * the gateway has no response to write into — the press arrived as an event,
   * not a request — so this is where it puts the same answer. Deliberately the
   * identical `InteractionResponse` shape, applied by the identical code, so
   * the two transports cannot drift into meaning different things.
   *
   * Bot-only, and only for its own message: `rewriteBotMessage` refuses
   * anything else. That is what makes this safe to expose at all — it is not a
   * general "edit any message" door, it is "replace the card I posted", which
   * is the one thing a bot already had the right to do.
   *
   * It also bypasses the edit window on purpose. The window exists to hold a
   * *person* to what they said; a bot retiring its own spent prompt, an hour
   * later, is not that.
   */
  app.post('/:id/messages/:messageId/callback', { preHandler: app.authenticate }, async (req, reply) => {
    const { id, messageId } = req.params as { id: string; messageId: string };
    if (!req.application) throw forbidden('This endpoint requires a bot token');

    const response = interactionResponse.parse(req.body);
    await app.limiter.consume(`user:${req.user.id}`, 'message.send');

    const message = await applyInteractionResponse(app, {
      botId: req.user.id,
      viewerId: req.user.id,
      conversationId: id,
      messageId,
      response,
    });

    return reply.send({ message });
  });

  app.get('/:id/messages/:messageId/reactions', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id, messageId } = req.params as { id: string; messageId: string };
    const { emoji } = req.query as { emoji?: string };
    await requireMember(app.db, id, req.user.id);

    const rows = await app.db
      .select({
        emoji: messageReactions.emoji,
        createdAt: messageReactions.createdAt,
        user: users,
        avatarKey: media.objectKey,
      })
      .from(messageReactions)
      .innerJoin(users, eq(users.id, messageReactions.userId))
      .leftJoin(media, eq(media.id, users.avatarMediaId))
      .where(
        and(
          eq(messageReactions.messageId, messageId),
          emoji ? eq(messageReactions.emoji, emoji) : undefined,
        ),
      )
      .orderBy(messageReactions.createdAt)
      .limit(200);

    return reply.send({
      reactions: rows.map((r) => ({
        emoji: r.emoji,
        user: toPublicUser(r.user, r.avatarKey),
        reactedAt: r.createdAt.toISOString(),
      })),
    });
  });

  // ── Pins ──────────────────────────────────────────────────────────────────

  app.put('/:id/pins/:messageId', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id, messageId } = req.params as { id: string; messageId: string };
    await requirePermission(app.db, id, req.user.id, Permission.PIN_MESSAGES);

    const [message] = await app.db
      .select({ id: messages.id, conversationId: messages.conversationId, deletedAt: messages.deletedAt })
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1);
    if (!message || message.conversationId !== id) throw notFound('Message');
    if (message.deletedAt) throw unprocessable('Cannot pin a deleted message');

    const countRows = (await app.db.execute(
      raw`select count(*)::int as count from pinned_messages where conversation_id = ${id}::uuid`,
    )) as unknown as Array<{ count: number }>;
    const count = countRows[0]?.count ?? 0;
    if (count >= LIMITS.pinnedPerConversation) {
      throw conflict(`At most ${LIMITS.pinnedPerConversation} pinned messages`);
    }

    await app.db.transaction(async (tx) => {
      await tx
        .insert(pinnedMessages)
        .values({ conversationId: id, messageId, pinnedById: req.user.id, position: count })
        .onConflictDoNothing();

      // A pin is announced in the timeline — otherwise members never notice it.
      await app.conversations.writeSystemMessage(tx, id, {
        event: 'message_pinned',
        actorId: req.user.id,
        value: messageId,
      });

      await app.events.toConversation(
        id,
        Event.PinAdd,
        { conversationId: id, messageId, pinnedBy: req.user.id },
        { exec: txExecutor(tx) },
      );
    });

    return reply.send({ pinned: true });
  });

  app.delete('/:id/pins/:messageId', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id, messageId } = req.params as { id: string; messageId: string };
    await requirePermission(app.db, id, req.user.id, Permission.PIN_MESSAGES);

    await app.db
      .delete(pinnedMessages)
      .where(and(eq(pinnedMessages.conversationId, id), eq(pinnedMessages.messageId, messageId)));

    await app.events.toConversation(id, Event.PinRemove, { conversationId: id, messageId });
    return reply.send({ pinned: false });
  });

  /** What they missed. See `MessageService.catchUp` for why it is not a summary. */
  app.get('/:id/catchup', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    return reply.send(await app.messages.catchUp(req.user.id, id));
  });

  app.get('/:id/pins', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await requirePermission(app.db, id, req.user.id, Permission.VIEW_CONVERSATION);

    const rows = await app.db
      .select({ message: messages, position: pinnedMessages.position, pinnedAt: pinnedMessages.pinnedAt })
      .from(pinnedMessages)
      .innerJoin(messages, eq(messages.id, pinnedMessages.messageId))
      // Filtered in SQL, not after hydration: the response below zips
      // `hydrated[i]` against `rows[i]` positionally, so dropping rows later
      // would pair every pin with somebody else's position.
      .where(
        and(
          eq(pinnedMessages.conversationId, id),
          isNull(messages.deletedAt),
          notDeletedForViewer(req.user.id),
        ),
      )
      .orderBy(pinnedMessages.position, desc(pinnedMessages.pinnedAt))
      .limit(LIMITS.pinnedPerConversation);

    const hydrated = await app.messages.hydrateMany(
      rows.map((r) => r.message),
      req.user.id,
    );

    return reply.send({
      pins: hydrated.map((m, i) => ({
        message: m,
        position: rows[i]!.position,
        pinnedAt: rows[i]!.pinnedAt.toISOString(),
      })),
    });
  });

  /**
   * The media wall: every image, video and GIF ever shared here, newest first.
   *
   * This is the group's shared memory, so it is a first-class query rather than
   * a client-side filter over history — filtering client-side would mean paging
   * through months of text to find last summer's photos. Rides the partial
   * `messages_type_idx` and the attachment join; seq-cursored like history.
   */
  app.get('/:id/media', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { limit, before } = messageHistoryQuery.parse(req.query);
    const ctx = await requirePermission(app.db, id, req.user.id, Permission.READ_HISTORY);
    // Same visibility floor as history: no paging back past your join point.
    const floor = ctx.member.historyStartSeq;

    const rows = await app.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, id),
          isNull(messages.deletedAt),
          notDeletedForViewer(req.user.id),
          raw`${messages.seq} >= ${floor}`,
          before !== undefined ? raw`${messages.seq} < ${before}` : undefined,
          raw`(${messages.type} = 'gif' or exists (
                select 1 from message_attachments a
                join media md on md.id = a.media_id
                where a.message_id = ${messages.id}
                  and (md.mime_type like 'image/%' or md.mime_type like 'video/%')))`,
        ),
      )
      .orderBy(desc(messages.seq))
      .limit(limit);

    return reply.send({
      messages: await app.messages.hydrateMany(rows, req.user.id),
      hasMore: rows.length === limit,
    });
  });

  // ── Polls ─────────────────────────────────────────────────────────────────

  app.post('/:id/messages/:messageId/poll/vote', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id, messageId } = req.params as { id: string; messageId: string };
    const body = pollVoteBody.parse(req.body);
    await requirePermission(app.db, id, req.user.id, Permission.SEND_POLLS);

    const [poll] = await app.db.select().from(polls).where(eq(polls.messageId, messageId)).limit(1);
    if (!poll) throw notFound('Poll');
    if (poll.closedAt || (poll.closesAt && poll.closesAt < new Date())) {
      throw conflict('This poll is closed');
    }
    if (!poll.multiSelect && body.optionIds.length > 1) {
      throw unprocessable('This poll allows one answer');
    }

    const validOptions = await app.db
      .select({ id: pollOptions.id })
      .from(pollOptions)
      .where(eq(pollOptions.pollId, poll.id));
    const validIds = new Set(validOptions.map((o) => o.id));
    for (const optionId of body.optionIds) {
      if (!validIds.has(optionId)) throw unprocessable('Unknown option');
    }

    await app.db.transaction(async (tx) => {
      // Replace rather than append: re-voting changes your answer, and an empty
      // array retracts it entirely.
      await tx
        .delete(pollVotes)
        .where(and(eq(pollVotes.pollId, poll.id), eq(pollVotes.userId, req.user.id)));

      if (body.optionIds.length > 0) {
        await tx.insert(pollVotes).values(
          body.optionIds.map((optionId) => ({
            pollId: poll.id,
            optionId,
            userId: req.user.id,
          })),
        );
      }
    });

    const tallies = await app.db
      .select({ id: pollOptions.id, voteCount: pollOptions.voteCount })
      .from(pollOptions)
      .where(eq(pollOptions.pollId, poll.id));

    await app.events.toConversation(id, Event.PollVote, {
      conversationId: id,
      messageId,
      pollId: poll.id,
      // Anonymous polls broadcast tallies only.
      userId: poll.isAnonymous ? null : req.user.id,
      options: tallies,
    });

    return reply.send({ ok: true, options: tallies });
  });

  app.post('/:id/messages/:messageId/poll/close', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id, messageId } = req.params as { id: string; messageId: string };
    await requireMember(app.db, id, req.user.id);

    const [row] = await app.db
      .select({ poll: polls, senderId: messages.senderId })
      .from(polls)
      .innerJoin(messages, eq(messages.id, polls.messageId))
      .where(eq(polls.messageId, messageId))
      .limit(1);
    if (!row) throw notFound('Poll');

    const ctx = await requireMember(app.db, id, req.user.id);
    const isAuthor = row.senderId === req.user.id;
    if (!isAuthor && !(ctx.permissions & Permission.MANAGE_CONVERSATION)) {
      throw conflict('Only the author or a moderator can close this poll');
    }

    await app.db.update(polls).set({ closedAt: new Date() }).where(eq(polls.id, row.poll.id));
    await app.events.toConversation(id, Event.PollClose, { conversationId: id, messageId, pollId: row.poll.id });
    return reply.send({ closed: true });
  });

  // ── Media gallery ─────────────────────────────────────────────────────────

  /** "Photos, videos and files in this chat" — one indexed scan per type. */
  app.get('/:id/gallery', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { type = 'image', limit = '50', before } = req.query as {
      type?: string;
      limit?: string;
      before?: string;
    };
    await requirePermission(app.db, id, req.user.id, Permission.READ_HISTORY);

    const rows = await app.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, id),
          eq(messages.type, type as never),
          isNull(messages.deletedAt),
          notDeletedForViewer(req.user.id),
          before ? lt(messages.seq, Number(before)) : undefined,
        ),
      )
      .orderBy(desc(messages.seq))
      .limit(Math.min(Number(limit), LIMITS.pageSizeMax));

    return reply.send({
      messages: await app.messages.hydrateMany(rows, req.user.id),
      nextCursor: rows.length > 0 ? String(rows.at(-1)!.seq) : null,
    });
  });
}
