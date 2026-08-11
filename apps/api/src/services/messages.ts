import {
  and,
  conversationMembers,
  conversationRoles,
  conversations,
  desc,
  memberRoles,
  eq,
  gt,
  inArray,
  isNull,
  linkPreviews,
  lt,
  media,
  messagePreviews,
  messageAttachments,
  messageMentions,
  messageReactions,
  messages,
  pinnedMessages,
  pollOptions,
  polls,
  pollVotes,
  sql as raw,
  stickers,
  users,
  type Database,
  type Media,
  type Message,
} from '@yappy/db';
import {
  Event,
  LIMITS,
  Permission,
  conflict,
  ErrorCode,
  forbidden,
  has,
  newId,
  notFound,
  unprocessable,
  type MessageType,
} from '@yappy/shared';
import {
  affiliationAvatar,
  affiliationAvatarOn,
  affiliationColumns,
  affiliationGroup,
  affiliationGroupOn,
  affiliationMembership,
  affiliationMembershipOn,
  pickAffiliation,
} from '../lib/affiliation.js';
import { notDeletedForViewer } from '../lib/hidden.js';
import type { z } from 'zod';
import type { sendMessageBody } from '@yappy/shared';
import { materialiseChannelMember, requireMember, requirePermission, type MemberContext } from '../lib/access.js';
import type { EventPublisher } from '../lib/events.js';
import { txExecutor } from '../lib/events.js';
import { mediaUrl, toMessage, type MessageExtras } from '../lib/serialize.js';

export type SendMessageInput = z.infer<typeof sendMessageBody> & {
  /**
   * Forward attribution, set only by the forward route. Deliberately absent
   * from `sendMessageBody`: it never comes off the wire, so a client cannot
   * dress an ordinary send up as "forwarded from" someone who never said it.
   * Living in the insert (rather than an update after the send) is what puts
   * the attribution on the gateway event — patched in afterwards, every live
   * recipient rendered the copy as a plain message and only a reload showed
   * the truth.
   */
  forwardedFrom?: { messageId: string; userId: string } | null;
};

export interface MessageServiceDeps {
  db: Database;
  events: EventPublisher;
  /** Enqueue side effects that must not run inside the send transaction. */
  enqueue: (name: string, data: Record<string, unknown>) => Promise<void>;
}

const URL_RE = /https?:\/\/[^\s<>"']+/gi;

/** Short text for the conversation list, computed once at send time. */
/**
 * The people a system line is about.
 *
 * `system` is a jsonb blob of ids — an actor and, for the membership events, a
 * list of targets. Reading them here is what lets the hydrator put names on
 * them, so a client does not have to own that job with a member roster it may
 * not have loaded yet and which cannot contain anyone who has left.
 */
export function systemActorIds(row: { type: string; system: unknown }): string[] {
  if (row.type !== 'system' || !row.system) return [];
  const s = row.system as { actorId?: unknown; targetIds?: unknown };
  const out: string[] = [];
  if (typeof s.actorId === 'string') out.push(s.actorId);
  if (Array.isArray(s.targetIds)) {
    for (const id of s.targetIds) if (typeof id === 'string') out.push(id);
  }
  return out;
}

/** id → name, dropping the ones that resolved to nothing. Null when empty, so
 *  a message with no system payload carries no extra key. */
export function namesFor(
  ids: string[],
  lookup: (id: string) => string | null,
): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const id of ids) {
    const name = lookup(id);
    if (name) out[id] = name;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function buildPreview(
  type: MessageType,
  content: string | null,
  hasAttachments: boolean,
  /**
   * Cards carry their text here rather than in `content`.
   *
   * Every yapper reply is `content: null` plus an embed, which fell through to
   * the empty-string default — so after any `/help`, `/privacy` or `/whoami`
   * the yapper row in the conversation list showed a blank last message, and
   * someone who had not seen the card in the timeline got no hint from the list
   * that anything had been said at all.
   */
  embeds?: Array<{ title?: string | null; description?: string | null }> | null,
): string {
  if (content && content.trim()) return content.slice(0, 160);
  const card = embeds?.[0];
  const cardText = card?.title ?? card?.description;
  if (cardText) return String(cardText).slice(0, 160);
  switch (type) {
    case 'image':
      return '📷 Photo';
    case 'video':
      return '🎥 Video';
    case 'audio':
      return '🎤 Voice message';
    case 'file':
      return '📎 File';
    case 'sticker':
      return 'Sticker';
    case 'gif':
      return 'GIF';
    case 'location':
      return '📍 Location';
    case 'contact':
      return '👤 Contact';
    case 'poll':
      return '📊 Poll';
    case 'call':
      return '📞 Call';
    default:
      return hasAttachments ? 'Attachment' : '';
  }
}

/**
 * Permission required to send a given message type.
 *
 * Split out because "can send messages" and "can send media" are separately
 * revocable — the standard way a group restricts a spammer without silencing
 * them entirely.
 */
function permissionForType(type: MessageType): bigint {
  switch (type) {
    case 'image':
    case 'video':
    case 'file':
      return Permission.SEND_MEDIA;
    case 'audio':
      return Permission.SEND_VOICE_NOTES;
    case 'sticker':
      return Permission.SEND_STICKERS;
    case 'gif':
      return Permission.SEND_GIFS;
    case 'poll':
      return Permission.SEND_POLLS;
    default:
      return Permission.SEND_MESSAGES;
  }
}

export class MessageService {
  constructor(private readonly deps: MessageServiceDeps) {}

  /**
   * Send a message.
   *
   * The transaction is kept deliberately short. It holds a row lock on the
   * conversation (that is how `seq` stays gapless), so anything that could be
   * slow — link scraping, push fan-out, transcoding — is enqueued for the
   * worker rather than awaited here. A slow HTTP call inside this block would
   * serialise every other sender in the same group behind it.
   */
  async send(
    actorId: string,
    conversationId: string,
    input: SendMessageInput,
  ): Promise<{ message: ReturnType<typeof toMessage>; created: boolean }> {
    const { db, events, enqueue } = this.deps;

    // Idempotency first: a retry must be cheap and must not re-check quotas.
    const existing = await db
      .select()
      .from(messages)
      .where(and(eq(messages.senderId, actorId), eq(messages.nonce, input.nonce)))
      .limit(1);
    if (existing[0]) {
      return { message: await this.hydrateOne(existing[0], actorId), created: false };
    }

    const ctx = await requirePermission(db, conversationId, actorId, permissionForType(input.type));

    await this.assertSlowMode(ctx, actorId);

    // Rich embeds are a bot affordance. People get link previews, which the
    // worker builds from what they actually posted — letting anyone hand-craft
    // a card is a phishing kit ("Yappy Security · verify your account here").
    //
    // Buttons are restricted for a sharper version of the same reason: a
    // component is a thing people are trained to press, and one that could be
    // authored by any member would be the most effective phishing surface in
    // the product.
    if (input.embeds?.length || input.components?.length) {
      const [sender] = await db
        .select({ isBot: users.isBot })
        .from(users)
        .where(eq(users.id, actorId))
        .limit(1);
      if (!sender?.isBot) {
        throw forbidden(
          input.components?.length
            ? 'Only bots can attach buttons'
            : 'Only bots can post rich embeds',
        );
      }
    }

    const attachments = await this.resolveAttachments(actorId, input.attachmentIds ?? []);
    if (input.type !== 'text' && input.type !== 'poll' && input.type !== 'location' && input.type !== 'contact') {
      const needsAttachment = ['image', 'video', 'audio', 'file'].includes(input.type);
      if (needsAttachment && attachments.length === 0) {
        throw unprocessable(`A ${input.type} message needs at least one attachment`);
      }
    }

    const replyTo = input.replyToId ? await this.loadReplyTarget(conversationId, input.replyToId) : null;

    const mentionIds = this.extractMentions(input, ctx);
    const expiresAt = this.resolveExpiry(ctx, input.expiresInSeconds);
    const messageId = newId();

    const inserted = await db.transaction(async (tx) => {
      const seqRows = (await tx.execute(
        raw`select allocate_message_seq(${conversationId}::uuid) as seq`,
      )) as unknown as Array<{ seq: string | number }>;
      const seq = Number(seqRows[0]!.seq);

      const [row] = await tx
        .insert(messages)
        .values({
          id: messageId,
          conversationId,
          seq,
          senderId: actorId,
          type: input.type,
          content: input.content ?? null,
          entities: input.entities ?? null,
          replyToId: replyTo?.id ?? null,
          // A reply to a threaded message joins that thread; a reply to a
          // top-level message starts one rooted at the target.
          threadRootId: input.threadRootId ?? replyTo?.threadRootId ?? null,
          stickerId: input.stickerId ?? null,
          forwardedFromMessageId: input.forwardedFrom?.messageId ?? null,
          forwardedFromUserId: input.forwardedFrom?.userId ?? null,
          embeds: await this.sanitiseEmbeds(actorId, input.embeds),
          components: input.components ?? [],
          gif: input.gif ?? null,
          location: input.location ?? null,
          contact: input.contact ?? null,
          nonce: input.nonce,
          silent: input.silent,
          expiresAt,
        })
        .returning();

      const message = row!;

      if (attachments.length > 0) {
        await tx.insert(messageAttachments).values(
          attachments.map((a, i) => ({
            messageId,
            mediaId: a.id,
            position: i,
            caption: null,
            isSpoiler: false,
          })),
        );
      }

      if (mentionIds.length > 0) {
        await tx
          .insert(messageMentions)
          .values(
            mentionIds.map((userId) => ({
              messageId,
              userId,
              conversationId,
              seq,
              isBroadcast: false,
            })),
          )
          .onConflictDoNothing();
      }

      let pollRecord = null;
      if (input.poll) {
        const pollId = newId();
        await tx.insert(polls).values({
          id: pollId,
          messageId,
          question: input.poll.question,
          multiSelect: input.poll.multiSelect,
          isAnonymous: input.poll.anonymous,
          closesAt: input.poll.closesAt ? new Date(input.poll.closesAt) : null,
        });
        const options = input.poll.options.map((label, i) => ({
          id: newId(),
          pollId,
          label,
          position: i,
        }));
        await tx.insert(pollOptions).values(options);
        pollRecord = { pollId, options };
      }

      await tx
        .update(conversations)
        .set({
          lastMessageId: messageId,
          lastMessageAt: message.createdAt,
          lastMessageSenderId: actorId,
          lastMessagePreview: buildPreview(
            input.type,
            input.content ?? null,
            attachments.length > 0,
            input.embeds as Array<{ title?: string | null; description?: string | null }> | null | undefined,
          ),
        })
        .where(eq(conversations.id, conversationId));

      // Your own message is read by definition. Skipping this leaves the
      // sender's own conversation showing an unread badge. In a channel the
      // row may not exist yet — posting is a perfectly ordinary first act.
      await materialiseChannelMember(tx, conversationId, actorId);
      await tx
        .update(conversationMembers)
        .set({ lastReadSeq: seq, lastDeliveredSeq: seq, lastReadAt: new Date() })
        .where(
          and(
            eq(conversationMembers.conversationId, conversationId),
            eq(conversationMembers.userId, actorId),
          ),
        );

      const payload = await this.hydrateOne(message, actorId, {
        replyTo: replyTo?.stub ?? null,
        attachments: attachments.map((m, i) => ({ media: m, caption: null, isSpoiler: false, position: i })),
        poll: pollRecord
          ? {
              id: pollRecord.pollId,
              question: input.poll!.question,
              multiSelect: input.poll!.multiSelect,
              isAnonymous: input.poll!.anonymous,
              closesAt: input.poll!.closesAt ?? null,
              closedAt: null,
              totalVoters: 0,
              options: pollRecord.options.map((o) => ({
                id: o.id,
                label: o.label,
                position: o.position,
                voteCount: 0,
              })),
              myVotes: [],
            }
          : null,
      });

      // Bound to the transaction: fires on commit, never on rollback.
      await events.toConversation(conversationId, Event.MessageCreate, payload, {
        exclude: [actorId],
        exec: txExecutor(tx),
      });

      return { message, payload, seq };
    });

    // Everything below is deferred and independently retryable.
    await enqueue('push.fanout', {
      messageId,
      conversationId,
      senderId: actorId,
      seq: inserted.seq,
      silent: input.silent,
      mentionIds,
    });

    const urls = input.content?.match(URL_RE)?.slice(0, 3) ?? [];
    if (urls.length > 0 && has(ctx.permissions, Permission.EMBED_LINKS)) {
      await enqueue('link.preview', { messageId, conversationId, urls });
    }

    return { message: inserted.payload, created: true };
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  /**
   * History window.
   *
   * `around` exists for "jump to message" (from search, a reply, or a
   * notification): it returns half a page either side of the target so the
   * client can render the message in context instead of at the edge of a page.
   */
  async history(
    actorId: string,
    conversationId: string,
    opts: { limit: number; before?: number; after?: number; around?: number; includeDeleted: boolean },
  ) {
    const { db } = this.deps;
    const ctx = await requirePermission(db, conversationId, actorId, Permission.READ_HISTORY);

    // A member added later must not be able to page back past their join point.
    const floor = ctx.member.historyStartSeq;

    const base = (extra: ReturnType<typeof and>) =>
      and(
        eq(messages.conversationId, conversationId),
        gt(messages.seq, floor),
        opts.includeDeleted ? undefined : isNull(messages.deletedAt),
        // Messages this particular reader deleted for themselves. Applied in
        // SQL rather than after hydration so `hasMore` below stays honest.
        notDeletedForViewer(actorId),
        extra,
      );

    let rows: Message[];
    if (opts.around !== undefined) {
      const half = Math.floor(opts.limit / 2);
      const [older, newer] = await Promise.all([
        db
          .select()
          .from(messages)
          .where(base(lt(messages.seq, opts.around + 1)))
          .orderBy(desc(messages.seq))
          .limit(half + 1),
        db
          .select()
          .from(messages)
          .where(base(gt(messages.seq, opts.around)))
          .orderBy(messages.seq)
          .limit(half),
      ]);
      rows = [...older.reverse(), ...newer];
    } else if (opts.after !== undefined) {
      rows = await db
        .select()
        .from(messages)
        .where(base(gt(messages.seq, opts.after)))
        .orderBy(messages.seq)
        .limit(opts.limit);
    } else {
      const desc_ = await db
        .select()
        .from(messages)
        .where(base(opts.before !== undefined ? lt(messages.seq, opts.before) : undefined))
        .orderBy(desc(messages.seq))
        .limit(opts.limit);
      rows = desc_.reverse();
    }

    const hydrated = await this.hydrateMany(rows, actorId);
    return {
      messages: hydrated,
      hasMore: rows.length === opts.limit,
      floorSeq: floor,
      latestSeq: ctx.conversation.messageSeq,
    };
  }

  async get(actorId: string, messageId: string) {
    const { db } = this.deps;
    const [row] = await db
      .select()
      .from(messages)
      .where(and(eq(messages.id, messageId), notDeletedForViewer(actorId)))
      .limit(1);
    // A message this reader deleted for themselves is gone as far as they are
    // concerned, so it 404s rather than being fetchable by id — otherwise
    // "jump to message" from a notification resurrects it.
    if (!row) throw notFound('Message');
    await requirePermission(db, row.conversationId, actorId, Permission.READ_HISTORY);
    return this.hydrateOne(row, actorId);
  }

  // ── Mutations ─────────────────────────────────────────────────────────────

  /**
   * Rewrite a bot's own message in place, as the response to a button press.
   *
   * Not routed through `edit`: that enforces an edit window and writes a
   * revision, both of which are about holding a *person* accountable for
   * changing what they said. A bot replacing its own spent prompt with the
   * outcome is not the same act, and a fifteen-minute-old prompt must still be
   * able to retire itself.
   */
  async rewriteBotMessage(
    botId: string,
    messageId: string,
    patch: { content?: string | null; embeds?: unknown[]; components?: unknown[] },
  ) {
    const { db, events } = this.deps;
    const [row] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
    if (!row) throw notFound('Message');
    if (row.senderId !== botId) throw forbidden('A bot can only rewrite its own messages');
    if (row.deletedAt) throw unprocessable('Message was deleted', ErrorCode.MessageDeleted);

    return db.transaction(async (tx) => {
      const [next] = await tx
        .update(messages)
        .set({
          ...(patch.content !== undefined ? { content: patch.content } : {}),
          ...(patch.embeds !== undefined ? { embeds: patch.embeds } : {}),
          ...(patch.components !== undefined ? { components: patch.components } : {}),
        })
        .where(eq(messages.id, messageId))
        .returning();

      if (patch.content !== undefined && row.conversationId) {
        const [conversation] = await tx
          .select({ lastMessageId: conversations.lastMessageId })
          .from(conversations)
          .where(eq(conversations.id, row.conversationId))
          .limit(1);
        if (conversation?.lastMessageId === messageId) {
          await tx
            .update(conversations)
            .set({ lastMessagePreview: buildPreview(row.type, patch.content, false) })
            .where(eq(conversations.id, row.conversationId));
        }
      }

      const payload = await this.hydrateOne(next!, botId);
      await events.toConversation(row.conversationId, Event.MessageUpdate, payload, {
        exec: txExecutor(tx),
      });
      return payload;
    });
  }

  async edit(actorId: string, messageId: string, content: string | null, entities: unknown) {
    const { db, events } = this.deps;
    const [row] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
    if (!row) throw notFound('Message');
    if (row.deletedAt) throw unprocessable('Message was deleted', ErrorCode.MessageDeleted);
    if (row.senderId !== actorId) throw notFound('Message');

    const ctx = await requirePermission(db, row.conversationId, actorId, Permission.EDIT_OWN_MESSAGES);

    const ageSeconds = (Date.now() - row.createdAt.getTime()) / 1000;
    if (ageSeconds > LIMITS.editWindowSeconds) {
      throw unprocessable('This message is too old to edit', ErrorCode.EditWindowExpired);
    }
    if (row.type !== 'text' && !content) {
      throw unprocessable('Only the caption of a media message can be edited');
    }

    const updated = await db.transaction(async (tx) => {
      // Keep the previous text: "edited" without history is a moderation hole.
      await tx.execute(
        raw`insert into message_revisions (id, message_id, content, entities, edited_at)
            values (${newId()}::uuid, ${messageId}::uuid, ${row.content}, ${JSON.stringify(row.entities)}::jsonb, now())`,
      );

      const [next] = await tx
        .update(messages)
        .set({ content, entities: (entities ?? null) as never, editedAt: new Date() })
        .where(eq(messages.id, messageId))
        .returning();

      // Editing the newest message must update the conversation-list preview.
      if (ctx.conversation.lastMessageId === messageId) {
        await tx
          .update(conversations)
          .set({ lastMessagePreview: buildPreview(row.type, content, false) })
          .where(eq(conversations.id, row.conversationId));
      }

      const payload = await this.hydrateOne(next!, actorId);
      await events.toConversation(row.conversationId, Event.MessageUpdate, payload, {
        exec: txExecutor(tx),
      });
      return payload;
    });

    return updated;
  }

  async remove(actorId: string, messageId: string, forEveryone: boolean) {
    const { db, events } = this.deps;
    const [row] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
    if (!row) throw notFound('Message');

    const ctx = await requireMember(db, row.conversationId, actorId);
    const isOwn = row.senderId === actorId;

    if (!forEveryone) {
      // Hide for this user only. The row stays intact for everyone else.
      await db.execute(
        raw`insert into message_deletions (message_id, user_id, created_at)
            values (${messageId}::uuid, ${actorId}::uuid, now())
            on conflict do nothing`,
      );
      // Only to the person who did it, and to *all* of their devices: hiding a
      // message on the phone and still seeing it on the tablet is the kind of
      // half-applied delete that makes people distrust the button.
      await events.toUser(actorId, Event.MessageDelete, {
        id: messageId,
        conversationId: row.conversationId,
        seq: row.seq,
        deletedBy: actorId,
        forMe: true,
      });
      return { deleted: true, forEveryone: false };
    }

    const allowed = isOwn
      ? has(ctx.permissions, Permission.DELETE_OWN_MESSAGES)
      : has(ctx.permissions, Permission.DELETE_ANY_MESSAGE);
    if (!allowed) throw notFound('Message');

    await db.transaction(async (tx) => {
      await tx
        .update(messages)
        .set({ deletedAt: new Date(), deletedById: actorId })
        .where(eq(messages.id, messageId));

      await tx
        .delete(pinnedMessages)
        .where(eq(pinnedMessages.messageId, messageId));

      if (ctx.conversation.lastMessageId === messageId) {
        await tx
          .update(conversations)
          .set({ lastMessagePreview: 'Message deleted' })
          .where(eq(conversations.id, row.conversationId));
      }

      await events.toConversation(
        row.conversationId,
        Event.MessageDelete,
        { id: messageId, conversationId: row.conversationId, seq: row.seq, deletedBy: actorId },
        { exec: txExecutor(tx) },
      );
    });

    return { deleted: true, forEveryone: true };
  }

  // ── Hydration ─────────────────────────────────────────────────────────────

  /**
   * Batch-load everything a page of messages needs.
   *
   * Written as an explicit set of `IN (…)` queries rather than a join per
   * message: a 50-message page costs five queries regardless of size, and the
   * shapes stay obvious. This is the classic N+1 trap in chat backends.
   */
  async hydrateMany(rows: Message[], viewerId: string) {
    if (rows.length === 0) return [];
    const { db } = this.deps;

    const ids = rows.map((r) => r.id);
    // Forwarded-from users ride in the sender fetch: attribution needs a name,
    // and the original sender is often not a member of this conversation, so
    // no members-based lookup could supply it.
    // System lines name people by id and have no sender of their own, so the
    // ids inside them ride along on the lookup that was happening anyway.
    const senderIds = [
      ...new Set(
        rows
          .flatMap((r) => [r.senderId, r.forwardedFromUserId, ...systemActorIds(r)])
          .filter((v): v is string => Boolean(v)),
      ),
    ];
    const replyIds = [...new Set(rows.map((r) => r.replyToId).filter((v): v is string => Boolean(v)))];

    const [attachmentRows, senderRows, myReactionRows, replyRows, pinRows, pollRows, previewRows] = await Promise.all([
      db
        .select({ att: messageAttachments, m: media })
        .from(messageAttachments)
        .innerJoin(media, eq(media.id, messageAttachments.mediaId))
        .where(inArray(messageAttachments.messageId, ids)),
      senderIds.length
        ? db
            .select({
              id: users.id,
              username: users.username,
              displayName: users.displayName,
              isBot: users.isBot,
              isVerified: users.isVerified,
              badge: users.badge,
              avatarKey: media.objectKey,
              ...affiliationColumns,
            })
            .from(users)
            .leftJoin(media, eq(media.id, users.avatarMediaId))
            .leftJoin(affiliationGroup, affiliationGroupOn(users.affiliationConversationId))
            .leftJoin(affiliationAvatar, affiliationAvatarOn())
            .leftJoin(affiliationMembership, affiliationMembershipOn(users.id))
            .where(inArray(users.id, senderIds))
        : Promise.resolve([]),
      db
        .select({ messageId: messageReactions.messageId, emoji: messageReactions.emoji })
        .from(messageReactions)
        .where(and(eq(messageReactions.userId, viewerId), inArray(messageReactions.messageId, ids))),
      replyIds.length
        ? db
            .select({
              id: messages.id,
              seq: messages.seq,
              senderId: messages.senderId,
              content: messages.content,
              type: messages.type,
              deletedAt: messages.deletedAt,
            })
            .from(messages)
            // Quoted previews obey the viewer's own tombstones too, or a
            // message you deleted for yourself is still readable in every
            // reply that quoted it.
            .where(and(inArray(messages.id, replyIds), notDeletedForViewer(viewerId)))
        : Promise.resolve([]),
      db
        .select({ messageId: pinnedMessages.messageId })
        .from(pinnedMessages)
        .where(inArray(pinnedMessages.messageId, ids)),
      db
        .select({ poll: polls, option: pollOptions })
        .from(polls)
        .innerJoin(pollOptions, eq(pollOptions.pollId, polls.id))
        .where(inArray(polls.messageId, ids)),
      // Unfurled links. Cached per URL and shared across every message that
      // cites the same page, which is why this is a join rather than a column.
      db
        .select({
          messageId: messagePreviews.messageId,
          url: linkPreviews.url,
          title: linkPreviews.title,
          description: linkPreviews.description,
          siteName: linkPreviews.siteName,
          imageKey: media.objectKey,
        })
        .from(messagePreviews)
        .innerJoin(linkPreviews, eq(linkPreviews.urlHash, messagePreviews.urlHash))
        .leftJoin(media, eq(media.id, linkPreviews.imageMediaId))
        .where(and(inArray(messagePreviews.messageId, ids), eq(linkPreviews.failed, false))),
    ]);

    /**
     * Name colours for this page's senders.
     *
     * A separate query rather than another join on the sender lookup: a member
     * can hold several roles, and joining would multiply the sender rows and
     * force a de-duplication pass. One small indexed read is simpler and, for a
     * page of at most a few dozen distinct senders, cheaper.
     */
    const roleRows =
      senderIds.length && rows[0]
        ? await db
            .select({
              userId: memberRoles.userId,
              name: conversationRoles.name,
              color: conversationRoles.color,
              position: conversationRoles.position,
            })
            .from(memberRoles)
            .innerJoin(conversationRoles, eq(conversationRoles.id, memberRoles.roleId))
            .where(
              and(
                eq(memberRoles.conversationId, rows[0].conversationId),
                inArray(memberRoles.userId, senderIds),
              ),
            )
            .orderBy(desc(conversationRoles.position))
        : [];

    // First writer wins because the query is ordered by position descending,
    // so the top role is the one that names and colours the member.
    const topRoleByUser = new Map<string, { name: string; color: string | null }>();
    const colorByUser = new Map<string, string>();
    for (const r of roleRows) {
      if (!topRoleByUser.has(r.userId)) topRoleByUser.set(r.userId, { name: r.name, color: r.color });
      if (r.color && !colorByUser.has(r.userId)) colorByUser.set(r.userId, r.color);
    }

    // Sticker images ride on the message now. Resolving them client-side from
    // installed packs only worked for people who had the pack — which is never
    // the receiving side of a sticker someone just made.
    const stickerIds = [...new Set(rows.map((r) => r.stickerId).filter((v): v is string => Boolean(v)))];
    const stickerRows = stickerIds.length
      ? await db
          .select({ sticker: stickers, mediaKey: media.objectKey })
          .from(stickers)
          .innerJoin(media, eq(media.id, stickers.mediaId))
          .where(inArray(stickers.id, stickerIds))
      : [];
    const stickerById = new Map(stickerRows.map((r) => [r.sticker.id, r]));

    const myVoteRows = pollRows.length
      ? await db
          .select({ pollId: pollVotes.pollId, optionId: pollVotes.optionId })
          .from(pollVotes)
          .where(
            and(
              eq(pollVotes.userId, viewerId),
              inArray(pollVotes.pollId, [...new Set(pollRows.map((p) => p.poll.id))]),
            ),
          )
      : [];

    const attachmentsByMessage = new Map<string, Array<{ media: Media; caption: string | null; isSpoiler: boolean; position: number }>>();
    for (const r of attachmentRows) {
      const list = attachmentsByMessage.get(r.att.messageId) ?? [];
      list.push({ media: r.m, caption: r.att.caption, isSpoiler: r.att.isSpoiler, position: r.att.position });
      attachmentsByMessage.set(r.att.messageId, list);
    }
    for (const list of attachmentsByMessage.values()) list.sort((a, b) => a.position - b.position);

    const senderById = new Map(senderRows.map((s) => [s.id, s]));
    const replyById = new Map(replyRows.map((r) => [r.id, r]));
    const pinned = new Set(pinRows.map((p) => p.messageId));

    const previewsByMessage = new Map<string, typeof previewRows>();
    for (const p of previewRows) {
      const list = previewsByMessage.get(p.messageId) ?? [];
      list.push(p);
      previewsByMessage.set(p.messageId, list);
    }

    const reactionsByMessage = new Map<string, string[]>();
    for (const r of myReactionRows) {
      const list = reactionsByMessage.get(r.messageId) ?? [];
      list.push(r.emoji);
      reactionsByMessage.set(r.messageId, list);
    }

    const pollsByMessage = new Map<string, NonNullable<MessageExtras['poll']>>();
    for (const r of pollRows) {
      let entry = pollsByMessage.get(r.poll.messageId);
      if (!entry) {
        entry = {
          id: r.poll.id,
          question: r.poll.question,
          multiSelect: r.poll.multiSelect,
          isAnonymous: r.poll.isAnonymous,
          closesAt: r.poll.closesAt?.toISOString() ?? null,
          closedAt: r.poll.closedAt?.toISOString() ?? null,
          totalVoters: r.poll.totalVoters,
          options: [],
          myVotes: myVoteRows.filter((v) => v.pollId === r.poll.id).map((v) => v.optionId),
        };
        pollsByMessage.set(r.poll.messageId, entry);
      }
      entry.options.push({
        id: r.option.id,
        label: r.option.label,
        position: r.option.position,
        voteCount: r.option.voteCount,
      });
    }
    for (const p of pollsByMessage.values()) p.options.sort((a, b) => a.position - b.position);

    return rows.map((row) => {
      const sender = row.senderId ? senderById.get(row.senderId) : undefined;
      const reply = row.replyToId ? replyById.get(row.replyToId) : undefined;
      const forwardedUser = row.forwardedFromUserId ? senderById.get(row.forwardedFromUserId) : undefined;
      const stickerRow = row.stickerId ? stickerById.get(row.stickerId) : undefined;
      return toMessage(row, {
        sticker: stickerRow
          ? {
              id: stickerRow.sticker.id,
              emoji: stickerRow.sticker.emoji,
              name: stickerRow.sticker.name,
              url: mediaUrl(stickerRow.mediaKey),
            }
          : null,
        forwardedFrom: row.forwardedFromUserId
          ? {
              userId: row.forwardedFromUserId,
              username: forwardedUser?.username ?? null,
              displayName: forwardedUser?.displayName ?? null,
            }
          : null,
        attachments: attachmentsByMessage.get(row.id) ?? [],
        sender: sender ? { ...sender } : null,
        senderAvatarKey: sender?.avatarKey ?? null,
        senderAffiliation: sender ? pickAffiliation(sender) : null,
        senderRoleColor: row.senderId ? (colorByUser.get(row.senderId) ?? null) : null,
        senderRoleName: row.senderId ? (topRoleByUser.get(row.senderId)?.name ?? null) : null,
        myReactions: reactionsByMessage.get(row.id) ?? [],
        systemNames: namesFor(systemActorIds(row), (id) => {
          const u = senderById.get(id);
          return u ? (u.displayName ?? u.username ?? null) : null;
        }),
        replyTo: reply
          ? {
              id: reply.id,
              seq: reply.seq,
              senderId: reply.senderId,
              preview: reply.deletedAt ? null : buildPreview(reply.type, reply.content, false),
              type: reply.type,
            }
          : null,
        poll: pollsByMessage.get(row.id) ?? null,
        isPinned: pinned.has(row.id),
        linkPreviews: (previewsByMessage.get(row.id) ?? []).map((p) => ({
          url: p.url,
          title: p.title,
          description: p.description,
          siteName: p.siteName,
          imageKey: p.imageKey,
        })),
      });
    });
  }

  async hydrateOne(row: Message, viewerId: string, overrides: MessageExtras = {}) {
    if (Object.keys(overrides).length > 0) {
      const [sender] = row.senderId
        ? await this.deps.db
            .select({
              id: users.id,
              username: users.username,
              displayName: users.displayName,
              isBot: users.isBot,
              isVerified: users.isVerified,
              badge: users.badge,
              avatarKey: media.objectKey,
              ...affiliationColumns,
            })
            .from(users)
            .leftJoin(media, eq(media.id, users.avatarMediaId))
            .leftJoin(affiliationGroup, affiliationGroupOn(users.affiliationConversationId))
            .leftJoin(affiliationAvatar, affiliationAvatarOn())
            .leftJoin(affiliationMembership, affiliationMembershipOn(users.id))
            .where(eq(users.id, row.senderId))
            .limit(1)
        : [undefined];
      // Only forwarded sends pay for this second lookup, and it is what puts
      // a name on the attribution in the POST response and gateway event.
      const [forwardedUser] = row.forwardedFromUserId
        ? await this.deps.db
            .select({ username: users.username, displayName: users.displayName })
            .from(users)
            .where(eq(users.id, row.forwardedFromUserId))
            .limit(1)
        : [undefined];
      // Same deal for a sticker send: the POST response and the gateway event
      // must carry the image, or the receiving client draws an empty square.
      const [stickerRow] = row.stickerId
        ? await this.deps.db
            .select({ sticker: stickers, mediaKey: media.objectKey })
            .from(stickers)
            .innerJoin(media, eq(media.id, stickers.mediaId))
            .where(eq(stickers.id, row.stickerId))
            .limit(1)
        : [undefined];
      return toMessage(row, {
        sticker: stickerRow
          ? {
              id: stickerRow.sticker.id,
              emoji: stickerRow.sticker.emoji,
              name: stickerRow.sticker.name,
              url: mediaUrl(stickerRow.mediaKey),
            }
          : null,
        sender: sender ? { ...sender } : null,
        senderAvatarKey: sender?.avatarKey ?? null,
        senderAffiliation: sender ? pickAffiliation(sender) : null,
        forwardedFrom: row.forwardedFromUserId
          ? {
              userId: row.forwardedFromUserId,
              username: forwardedUser?.username ?? null,
              displayName: forwardedUser?.displayName ?? null,
            }
          : null,
        ...overrides,
      });
    }
    const [one] = await this.hydrateMany([row], viewerId);
    return one!;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async assertSlowMode(ctx: MemberContext, actorId: string) {
    if (ctx.conversation.slowModeSeconds <= 0) return;
    if (has(ctx.permissions, Permission.MANAGE_CONVERSATION)) return;

    const rows = (await this.deps.db.execute(
      raw`select check_slow_mode(${ctx.conversation.id}::uuid, ${actorId}::uuid, ${ctx.conversation.slowModeSeconds}) as wait`,
    )) as unknown as Array<{ wait: number }>;

    const wait = Number(rows[0]?.wait ?? 0);
    if (wait > 0) {
      throw conflict(`Slow mode: wait ${Math.ceil(wait)}s`, ErrorCode.SlowMode);
    }
  }

  /** Attachments must belong to the sender, be confirmed, and not be reused. */
  private async resolveAttachments(actorId: string, ids: string[]): Promise<Media[]> {
    if (ids.length === 0) return [];
    if (ids.length > LIMITS.attachmentsPerMessage) {
      throw unprocessable(`At most ${LIMITS.attachmentsPerMessage} attachments per message`);
    }

    const rows = await this.deps.db
      .select()
      .from(media)
      .where(and(inArray(media.id, ids), eq(media.ownerId, actorId), isNull(media.deletedAt)));

    if (rows.length !== ids.length) throw notFound('Attachment');
    for (const m of rows) {
      if (!m.confirmedAt) throw unprocessable('Attachment upload was never confirmed');
      if (m.status === 'quarantined') throw unprocessable('Attachment failed moderation');
      if (m.status === 'failed') throw unprocessable('Attachment failed processing');
    }
    // Preserve the caller's ordering — it is the order shown in the gallery.
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.map((id) => byId.get(id)!);
  }

  private async loadReplyTarget(conversationId: string, replyToId: string) {
    const [row] = await this.deps.db
      .select({
        id: messages.id,
        conversationId: messages.conversationId,
        threadRootId: messages.threadRootId,
        // Enough to build the quoted stub as well as validate the target. The
        // send path used to select only the first three and then hand the
        // hydrator no `replyTo` at all, so the POST response came back without
        // the quote while history had it — a reply rendered correctly for one
        // frame, lost its quote when the server's copy replaced the optimistic
        // bubble, and got it back only when the conversation was reopened.
        seq: messages.seq,
        senderId: messages.senderId,
        content: messages.content,
        type: messages.type,
        deletedAt: messages.deletedAt,
      })
      .from(messages)
      .where(eq(messages.id, replyToId))
      .limit(1);
    // Replying across conversations would let a sender quote a private thread
    // into a public one.
    if (!row || row.conversationId !== conversationId) throw notFound('Message being replied to');
    return {
      id: row.id,
      threadRootId: row.threadRootId ?? row.id,
      stub: {
        id: row.id,
        seq: row.seq,
        senderId: row.senderId,
        preview: row.deletedAt ? null : buildPreview(row.type, row.content, false),
        type: row.type,
      },
    };
  }

  private extractMentions(input: SendMessageInput, ctx: MemberContext): string[] {
    const ids = new Set<string>();
    for (const e of input.entities ?? []) {
      if (e.type === 'mention') ids.add(e.userId);
      if (e.type === 'mention_all' && !has(ctx.permissions, Permission.MENTION_ALL)) {
        throw unprocessable('You cannot mention everyone in this conversation');
      }
    }
    return [...ids];
  }

  /**
   * Strip the trusted embed `kind` from anyone who is not yapper.
   *
   * `embeds` is a JSONB blob a bot author controls end to end, and `kind`
   * changes how a client *treats* the card rather than merely how it looks —
   * an announcement renders with staff framing and no line cap. Left
   * unguarded, any third-party bot could dress its output as a first-party
   * notice from us. That is an impersonation primitive, and adding the field
   * without this would be handing it out.
   *
   * Enforced here rather than in the zod schema because the answer depends on
   * who is sending, which the schema cannot see. The clients check
   * independently — they honour `kind` only from a staff-badged bot — so a bug
   * in either layer alone is not enough.
   */
  private async sanitiseEmbeds(
    actorId: string,
    embeds: Array<Record<string, unknown>> | undefined,
  ): Promise<Array<Record<string, unknown>>> {
    const list = embeds ?? [];
    if (list.length === 0) return [];
    if (!list.some((e) => e && typeof e === 'object' && 'kind' in e && e.kind)) return list;

    const [sender] = await this.deps.db
      .select({ badge: users.badge, isBot: users.isBot })
      .from(users)
      .where(eq(users.id, actorId))
      .limit(1);

    /**
     * A bot wearing the staff badge, which is the same predicate the clients
     * apply. Deliberately the *badge* and not `is_staff`: `is_staff` is an
     * authorisation column for the moderation endpoints, and yapper does not
     * carry it — it is created with `is_bot` and `badge = 'staff'`. Checking
     * `is_staff` here would have silently stripped yapper's own field and left
     * announcements rendering as ordinary cards.
     *
     * The badge is operator-granted and never purchasable, so it is a real
     * trust signal rather than something an app author can set. A staff human
     * posting by hand does not qualify either: the treatment says "this is a
     * system notice", and a person's message is not one.
     */
    if (sender?.isBot && sender.badge === 'staff') return list;

    return list.map((embed) => {
      if (!embed || typeof embed !== 'object' || !('kind' in embed)) return embed;
      const { kind: _dropped, ...rest } = embed as Record<string, unknown>;
      return rest;
    });
  }

  private resolveExpiry(ctx: MemberContext, override?: number | null): Date | null {
    const seconds = override ?? ctx.conversation.disappearingSeconds;
    if (!seconds || seconds <= 0) return null;
    return new Date(Date.now() + seconds * 1000);
  }
}
