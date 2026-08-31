import {
  and,
  conversationMembers,
  customEmojis,
  conversationRoles,
  conversations,
  desc,
  memberRoles,
  eq,
  gt,
  inArray,
  isNull,
  linkPreviews,
  liveLocations,
  lt,
  media,
  messagePreviews,
  messageAttachments,
  messageMentions,
  messageReactions,
  messageEnvelopes,
  messages,
  pinnedMessages,
  pollOptions,
  polls,
  pollVotes,
  sql as raw,
  stickers,
  users,
  uuidArray,
  type Database,
  type Media,
  type Message,
  type MessageEntity,
} from '@yappy/db';
import {
  Event,
  LIMITS,
  LIVE_LOCATION_MAX_SECONDS,
  Permission,
  ENCRYPTED_PREVIEW,
  markdownToEntities,
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
import { inviteCodeFromUrl, resolveInviteCards } from '../lib/invitecards.js';
import type { z } from 'zod';
import type { sendMessageBody } from '@yappy/shared';
import { materialiseChannelMember, requireMember, requirePermission, type MemberContext } from '../lib/access.js';
import type { EventPublisher } from '../lib/events.js';
import { txExecutor } from '../lib/events.js';
import { mediaUrl, publicUserColumns, toMedia, toMessage, toPublicUser, type MessageExtras } from '../lib/serialize.js';

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
  /**
   * The name its author addresses this message by, set only by `setCard`.
   * Absent from `sendMessageBody` on purpose: a card is claimed through the
   * card endpoint, which knows how to find an existing one, and never by an
   * ordinary send that would collide with it.
   */
  cardKey?: string | null;
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

/**
 * Names and colours for the roles a message mentions.
 *
 * A role that resolved to nothing is dropped rather than guessed at: it was
 * deleted after the message was sent, and the client's fallback for an
 * unnamed role id is the right answer there.
 */
export function rolesFor(
  row: { entities: unknown },
  lookup: Map<string, { name: string; color: string | null }>,
): Record<string, { name: string; color: string | null }> | null {
  const out: Record<string, { name: string; color: string | null }> = {};
  for (const e of (row.entities as MessageEntity[] | null) ?? []) {
    if (e.type !== 'mention_role') continue;
    const role = lookup.get(e.roleId);
    if (role) out[e.roleId] = role;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Titles for the channels a message points at.
 *
 * Same shape as `rolesFor`, and the same rule for a miss: a channel id that
 * resolved to nothing renders as the plain text it was typed as. That covers
 * a deleted channel and — the case that matters — one the *reader* cannot
 * see. A signpost is still a disclosure: resolving `#tickets-mark` for
 * somebody with no access would tell them the channel exists and what it is
 * called. The lookup is built from the reader's visible channels only, so a
 * miss here is the privacy behaviour rather than an error path.
 */
export function channelsFor(
  row: { entities: unknown },
  lookup: Map<string, { title: string }>,
): Record<string, { title: string }> | null {
  const out: Record<string, { title: string }> = {};
  for (const e of (row.entities as MessageEntity[] | null) ?? []) {
    if (e.type !== 'mention_channel') continue;
    const channel = lookup.get(e.channelId);
    if (channel) out[e.channelId] = channel;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * The custom emoji a message names, resolved to pictures.
 *
 * Same shape and the same fallback as `channelsFor`: an id that resolves to
 * nothing is left out, and the client draws the literal `:name:` that is
 * still sitting in the text. That covers a deleted emoji and one belonging to
 * a group the reader is not in — a forwarded message carries its original
 * ids, and those must not become a picture the reader's group never had.
 */
export function emojiFor(
  row: { entities: unknown },
  lookup: Map<string, { name: string; url: string; animated: boolean }>,
): Record<string, { name: string; url: string; animated: boolean }> | null {
  const out: Record<string, { name: string; url: string; animated: boolean }> = {};
  for (const e of (row.entities as MessageEntity[] | null) ?? []) {
    if (e.type !== 'custom_emoji') continue;
    const emoji = lookup.get(e.emojiId);
    if (emoji) out[e.emojiId] = emoji;
  }
  return Object.keys(out).length > 0 ? out : null;
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
    /**
     * The device this came from, when a person sent it. It is the only client
     * that already has the message on screen, so it is the only one to skip in
     * the fan-out — see the publish below.
     */
    origin?: { deviceId?: string | null },
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

    /**
     * A forum's top level is titles.
     *
     * Underneath, a post is an ordinary root message and its replies are an
     * ordinary thread — the posture is the only new idea. Which is exactly
     * why the title has to be required here: without it a client could post
     * a nameless row into a list whose entire job is showing names, and the
     * forum would degrade into a chat drawn badly.
     */
    const inThread = Boolean(input.threadRootId ?? input.replyToId);
    if (ctx.conversation.isForum && !inThread && !input.title) {
      throw unprocessable('A forum post needs a title');
    }
    // Elsewhere a title has nothing to draw it, so refuse rather than store
    // a field no client will ever show.
    if (input.title && (inThread || !ctx.conversation.isForum)) {
      throw unprocessable('Only a forum post can have a title');
    }

    /**
     * Markdown, but only on a board.
     *
     * A board is a page, and a page wants emphasis and links. A chat does
     * not: people type asterisks around words for reasons that have nothing
     * to do with formatting, and silently eating them out of a sentence
     * somebody meant literally is worse than not supporting markdown at all.
     * Parsed here rather than in three clients — see @yappy/shared/markdown.
     */
    if (ctx.conversation.isBoard) {
      const parsed = markdownToEntities(input.content, input.entities);
      if (parsed) {
        input = { ...input, content: parsed.content, entities: parsed.entities as never };
      }
    }

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

    input = { ...input, entities: this.sanitiseEntities(input.content, input.entities) as never };
    const mentions = this.extractMentions(input.entities, ctx);
    const mentionIds = await this.visibleMentionIds(conversationId, mentions.userIds);
    const mentionRoleIds = await this.mentionableRoles(ctx, mentions.roleIds);
    // The space owns membership and roles; a channel owns only messages.
    const memberScope = ctx.conversation.parentId ?? conversationId;
    const expiresAt = this.resolveExpiry(ctx, input.expiresInSeconds);
    const messageId = newId();
    // This can require a sender lookup. Do it before allocate_message_seq()
    // takes the per-conversation lock so trust checks never serialize senders.
    const embeds = await this.sanitiseEmbeds(actorId, input.embeds);

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
          isEncrypted: Boolean(input.envelopes?.length),
          cardKey: input.cardKey ?? null,
          content: input.content ?? null,
          title: input.title ?? null,
          entities: input.entities ?? null,
          replyToId: replyTo?.id ?? null,
          // A reply to a threaded message joins that thread; a reply to a
          // top-level message starts one rooted at the target.
          threadRootId: input.threadRootId ?? replyTo?.threadRootId ?? null,
          stickerId: input.stickerId ?? null,
          forwardedFromMessageId: input.forwardedFrom?.messageId ?? null,
          forwardedFromUserId: input.forwardedFrom?.userId ?? null,
          embeds,
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

      /**
       * A location that is going to keep moving.
       *
       * `liveUntil` on the payload is what makes a share live, and this is the
       * row the pings will overwrite. Clamped here rather than trusted: the
       * duration decides how long a person's position is readable by a whole
       * group, and it is the one number in this feature nobody should be able
       * to set from a client.
       */
      if (input.type === 'location' && input.location?.liveUntil) {
        const requested = new Date(input.location.liveUntil).getTime();
        const ceiling = Date.now() + LIVE_LOCATION_MAX_SECONDS * 1_000;
        const expiresAt = new Date(Math.min(Number.isFinite(requested) ? requested : 0, ceiling));
        if (expiresAt.getTime() <= Date.now()) {
          throw unprocessable('A live location has to end in the future');
        }

        await tx.insert(liveLocations).values({
          messageId,
          conversationId,
          userId: actorId,
          latitude: input.location.latitude,
          longitude: input.location.longitude,
          expiresAt,
        });
      }

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

      /**
       * The bodies, one per recipient device.
       *
       * Written inside the same transaction as the message: a message row
       * with no envelopes is one nobody can read, and it would still have
       * taken a `seq` and rung everybody's phone.
       */
      if (input.envelopes?.length) {
        await tx.insert(messageEnvelopes).values(
          input.envelopes.map((e) => ({
            messageId,
            deviceId: e.deviceId,
            ciphertext: e.ciphertext,
          })),
        );
      }

      /*
       * Direct mentions first, and the wider ones after with
       * `do nothing` — the primary key is (message_id, user_id), so
       * somebody named personally in a message that also says @everyone
       * keeps the direct row. That is the stronger of the two: a broadcast
       * is styled more quietly and is the kind of thing people learn to
       * skim past.
       */
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

      /*
       * `insert … select`, not a list of ids built in Node.
       *
       * The row count here is the size of the group, and a space with five
       * thousand members would mean five thousand uuids marshalled out of
       * the database and straight back into it. The reason it matters
       * beyond tidiness: whatever cap that list acquired would be a silent
       * one, and an `@everyone` that reached most of the room is worse than
       * one that reached none, because nobody can tell.
       */
      /*
       * `@everyone` means everyone who is here, not everyone in the space.
       *
       * `memberScope` is the space, because that is where membership lives —
       * and for an ordinary channel the space's roster is exactly the
       * channel's audience. For a restricted one it is not, and this insert
       * was reaching straight past the restriction: every member of the space
       * got a row, a badge, a push, and a readable copy of the message in
       * their mentions inbox, for a channel the app will not even list for
       * them. The `conversation_is_gated` branch keeps the ordinary case on
       * the original query, which is the cheap one.
       */
      if (mentions.broadcast) {
        await tx.execute(raw`
          insert into message_mentions (message_id, user_id, conversation_id, seq, is_broadcast)
          select ${messageId}::uuid, am.user_id, ${conversationId}::uuid, ${seq}::bigint, true
            from conversation_members am
           where am.conversation_id = ${memberScope}::uuid
             and am.left_at is null
             and am.user_id <> ${actorId}::uuid
             and (not conversation_is_gated(${conversationId}::uuid)
                  or am.user_id in (
                    select v.user_id from conversation_viewers(${conversationId}::uuid) v
                  ))
          on conflict do nothing
        `);
      }

      if (mentionRoleIds.length > 0) {
        await tx.execute(raw`
          insert into message_mentions (message_id, user_id, conversation_id, seq, is_broadcast)
          select distinct ${messageId}::uuid, mr.user_id, ${conversationId}::uuid, ${seq}::bigint, true
            from member_roles mr
            join conversation_members am
              on am.conversation_id = mr.conversation_id
             and am.user_id = mr.user_id
             and am.left_at is null
           where mr.conversation_id = ${memberScope}::uuid
             and mr.role_id = any(${uuidArray(mentionRoleIds)})
             and mr.user_id <> ${actorId}::uuid
             -- Same restriction as the broadcast above: holding the role is
             -- not the same as being able to see where it was called.
             and (not conversation_is_gated(${conversationId}::uuid)
                  or mr.user_id in (
                    select v.user_id from conversation_viewers(${conversationId}::uuid) v
                  ))
          on conflict do nothing
        `);
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
          // An encrypted body has nothing to preview: `content` holds the
          // notice, and putting a whole sentence about encryption in the
          // conversation list says less than two words do.
          lastMessagePreview: input.envelopes?.length
            ? ENCRYPTED_PREVIEW
            : buildPreview(
                input.type,
                input.content ?? null,
                attachments.length > 0,
                embeds as
                  | Array<{ title?: string | null; description?: string | null }>
                  | null
                  | undefined,
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

      /**
       * Bound to the transaction: fires on commit, never on rollback.
       *
       * Skipping the sending *device* rather than the sending account is the
       * difference between "my phone shows what I just sent from my laptop"
       * and "my phone shows it after I back out of the chat and open it
       * again". The device that posted already rendered the POST response;
       * every other device this account has is in exactly the position of any
       * other member. Without a device (a bot, or something the server sent on
       * someone's behalf) the account is still excluded — a bot that receives
       * its own messages is a bot that can answer itself.
       */
      await events.toConversation(conversationId, Event.MessageCreate, payload, {
        exclude: origin?.deviceId ? undefined : [actorId],
        excludeDevice: origin?.deviceId ?? undefined,
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
      /*
       * Passed as flags rather than as the expanded recipient list, for the
       * same reason the insert above is a `select`: the job's own query
       * already walks the membership, so it can widen its predicate instead
       * of being handed thousands of ids through a queue payload.
       */
      broadcast: mentions.broadcast,
      mentionRoleIds,
    });

    const urls = input.content?.match(URL_RE)?.slice(0, 3) ?? [];
    if (urls.length > 0 && has(ctx.permissions, Permission.EMBED_LINKS)) {
      await enqueue('link.preview', { messageId, conversationId, urls });
    }

    /**
     * The sending device gets its own copy back with the 201.
     *
     * The broadcast payload cannot carry one — a single event reaches every
     * device and each needs a different ciphertext — but the response to a POST
     * has exactly one reader, and it is the device that just sealed the
     * message. Without this the sender's own words come back unreadable on the
     * next reload, which is the one failure nobody would forgive. Nothing is
     * looked up: the client handed us this ciphertext a moment ago.
     */
    const own =
      origin?.deviceId && input.envelopes?.length
        ? input.envelopes.find((e) => e.deviceId === origin.deviceId)?.ciphertext
        : undefined;

    return {
      message: own ? { ...inserted.payload, ciphertext: own } : inserted.payload,
      created: true,
    };
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
    opts: {
      limit: number;
      before?: number;
      after?: number;
      around?: number;
      includeDeleted: boolean;
      /**
       * Which device is asking, so an encrypted message can be handed the one
       * ciphertext addressed to it. Absent means none are attached, which is
       * what every caller that is not a person reading their own history
       * wants.
       */
      deviceId?: string;
    },
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

    const hydrated = await this.hydrateMany(rows, actorId, opts.deviceId);
    return {
      messages: hydrated,
      hasMore: rows.length === opts.limit,
      floorSeq: floor,
      latestSeq: ctx.conversation.messageSeq,
    };
  }

  /**
   * What somebody missed, built from structure rather than generated.
   *
   * Deliberately not a summary. A busy group is unreadable after a day away, so
   * people mute it, and then they leave — but an AI paragraph about what was
   * said can be subtly wrong in a way nobody can check, and it costs money on
   * every open. Counts, faces, pictures and the messages that named you are
   * things that are simply true, and between them they answer the question
   * actually being asked: is there anything in here for me.
   */
  async catchUp(actorId: string, conversationId: string) {
    const { db } = this.deps;
    const ctx = await requirePermission(db, conversationId, actorId, Permission.READ_HISTORY);

    const since = Math.max(ctx.member.lastReadSeq, ctx.member.historyStartSeq);
    const upTo = ctx.conversation.messageSeq;

    if (upTo <= since) {
      return {
        since,
        upTo,
        newMessages: 0,
        capped: false,
        participants: [],
        media: [],
        mentions: [],
        pins: [],
      };
    }

    /**
     * How far back to look.
     *
     * Somebody returning after a month should not make the server aggregate a
     * month of a busy group to draw one card. The window is the recent end of
     * what they missed, and `capped` tells the client the count is a floor
     * rather than a total — so it can say "500+" instead of a wrong number.
     */
    const MAX_SCAN = 500;
    const scanFrom = Math.max(since, upTo - MAX_SCAN);
    const capped = scanFrom > since;

    const [counts, mediaRows, mentionRows, pinRows] = await Promise.all([
      db.execute(raw`
        select m.sender_id::text as sender_id, count(*)::int as n
          from messages m
         where m.conversation_id = ${conversationId}::uuid
           and m.seq > ${scanFrom} and m.seq <= ${upTo}
           and m.deleted_at is null
           and m.sender_id is not null
           and m.sender_id <> ${actorId}::uuid
         group by m.sender_id
         order by n desc
         limit 8
      `) as unknown as Promise<Array<{ sender_id: string; n: number }>>,

      db
        .select({ media, seq: messages.seq, messageId: messages.id })
        .from(messages)
        .innerJoin(messageAttachments, eq(messageAttachments.messageId, messages.id))
        .innerJoin(media, eq(media.id, messageAttachments.mediaId))
        .where(
          and(
            eq(messages.conversationId, conversationId),
            gt(messages.seq, scanFrom),
            isNull(messages.deletedAt),
            isNull(media.deletedAt),
            inArray(messages.type, ['image', 'video']),
            notDeletedForViewer(actorId),
          ),
        )
        .orderBy(desc(messages.seq))
        .limit(8),

      // The inbox index — (user_id, conversation_id, seq) — is exactly this
      // question, which is why it exists.
      db
        .select({ messageId: messageMentions.messageId })
        .from(messageMentions)
        .where(
          and(
            eq(messageMentions.userId, actorId),
            eq(messageMentions.conversationId, conversationId),
            gt(messageMentions.seq, since),
          ),
        )
        .orderBy(desc(messageMentions.seq))
        .limit(5),

      db
        .select({ messageId: pinnedMessages.messageId })
        .from(pinnedMessages)
        .where(
          and(
            eq(pinnedMessages.conversationId, conversationId),
            ctx.member.lastReadAt ? gt(pinnedMessages.pinnedAt, ctx.member.lastReadAt) : undefined,
          ),
        )
        .orderBy(desc(pinnedMessages.pinnedAt))
        .limit(3),
    ]);

    const newMessages = counts.reduce((total, row) => total + Number(row.n), 0);

    const people = counts.length
      ? await db
          .select({ ...publicUserColumns, avatarKey: media.objectKey })
          .from(users)
          .leftJoin(media, eq(media.id, users.avatarMediaId))
          .where(
            inArray(
              users.id,
              counts.map((c) => c.sender_id),
            ),
          )
      : [];
    const peopleById = new Map(people.map((p) => [p.id, p]));

    // Mentions and pins are shown as real messages, so they go through the same
    // hydration as the timeline rather than a second, thinner rendering that
    // would drift from it.
    const quoted = [...mentionRows, ...pinRows].map((r) => r.messageId);
    const quotedRows = quoted.length
      ? await db.select().from(messages).where(inArray(messages.id, quoted))
      : [];
    const hydrated = await this.hydrateMany(quotedRows, actorId);
    const hydratedById = new Map(hydrated.map((m) => [(m as { id: string }).id, m]));

    return {
      since,
      upTo,
      newMessages,
      capped,
      participants: counts
        .map((c) => ({ row: peopleById.get(c.sender_id), count: Number(c.n) }))
        .filter((p): p is { row: NonNullable<typeof p.row>; count: number } => Boolean(p.row))
        .map((p) => ({ user: toPublicUser(p.row, p.row.avatarKey), count: p.count })),
      media: mediaRows.map((r) => ({ ...toMedia(r.media), messageId: r.messageId, seq: r.seq })),
      mentions: mentionRows.map((r) => hydratedById.get(r.messageId)).filter(Boolean),
      pins: pinRows.map((r) => hydratedById.get(r.messageId)).filter(Boolean),
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

  /**
   * Edit one of your own messages.
   *
   * A patch: an absent field is left alone, `content: null` clears the text.
   * Before this, an edit that carried only `embeds` reached here as
   * `content = null` and silently erased the sentence above the card — and the
   * embeds themselves were dropped on the floor by the schema, so a bot
   * rewriting a live card watched every tick succeed and change nothing.
   */
  /**
   * Put a card on a board, by name.
   *
   * Creates the message the first time and edits the same one every time
   * after, so the caller never handles an id. That is the entire point: a
   * bot maintaining a price, a score, a countdown is a process that restarts,
   * redeploys, or runs as a cron job with no memory of the last run. Handed a
   * name, it can keep one card alive across all of that.
   *
   * The first post can ring phones if the caller insists; the rewrites cannot,
   * because they are edits. A card that pushed a notification every ten
   * seconds would be indistinguishable from an attack.
   */
  async setCard(
    actorId: string,
    conversationId: string,
    key: string,
    input: {
      content?: string | null;
      entities?: unknown;
      embeds?: unknown;
      components?: unknown;
      silent?: boolean;
    },
  ) {
    const { db } = this.deps;

    const [existing] = await db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.senderId, actorId),
          eq(messages.cardKey, key),
          isNull(messages.deletedAt),
        ),
      )
      .limit(1);

    if (existing) {
      const parsed = markdownToEntities(input.content, input.entities);
      const message = await this.edit(actorId, existing.id, {
        content: parsed?.content ?? input.content,
        entities: parsed?.entities ?? input.entities,
        embeds: input.embeds,
        components: input.components,
      });
      return { message, created: false };
    }

    // Nothing under this name, so publish one. That covers a card that was
    // deleted as well as one that never existed: deleting a card releases
    // its name (see `remove`), and a bot still calling `set` is still saying
    // something lives here — so it goes back up, as a new card. Someone who
    // wants it gone for good takes away the bot's permission to post.
    const sent = await this.send(actorId, conversationId, {
      nonce: `card:${conversationId}:${actorId}:${key}`,
      type: 'text',
      content: input.content ?? null,
      entities: input.entities as never,
      embeds: input.embeds as never,
      components: input.components as never,
      silent: input.silent ?? true,
      cardKey: key,
    } as never);

    return { message: sent.message, created: sent.created };
  }

  /**
   * Take a card down by name.
   *
   * The counterpart to `setCard`, and it exists for the same reason: a
   * caller that never learned the message id has no other way to reach it.
   * A bot retiring a feed it no longer publishes should not have to ask an
   * admin to find the message and delete it by hand.
   */
  async deleteCard(actorId: string, conversationId: string, key: string) {
    const { db } = this.deps;

    const [existing] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.senderId, actorId),
          eq(messages.cardKey, key),
          isNull(messages.deletedAt),
        ),
      )
      .limit(1);

    if (!existing) throw notFound('Card');
    return this.remove(actorId, existing.id, true);
  }

  async edit(
    actorId: string,
    messageId: string,
    patch: {
      content?: string | null;
      entities?: unknown;
      embeds?: unknown;
      components?: unknown;
    },
  ) {
    const { db, events } = this.deps;
    const [row] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
    if (!row) throw notFound('Message');
    if (row.deletedAt) throw unprocessable('Message was deleted', ErrorCode.MessageDeleted);
    if (row.senderId !== actorId) throw notFound('Message');

    const ctx = await requirePermission(db, row.conversationId, actorId, Permission.EDIT_OWN_MESSAGES);

    /*
     * The window exists so a message cannot be quietly rewritten long after
     * people read it and answered it. A card is the opposite object: its
     * name is a standing promise that this slot holds the current value,
     * and nobody read `sol-price` as "what the bot said on Tuesday". Left
     * under the window a feed simply stops after two days — the bot keeps
     * calling, the card keeps showing a stale number, and nothing says so.
     */
    const ageSeconds = (Date.now() - row.createdAt.getTime()) / 1000;
    if (!row.cardKey && ageSeconds > LIMITS.editWindowSeconds) {
      throw unprocessable('This message is too old to edit', ErrorCode.EditWindowExpired);
    }

    const editsText = patch.content !== undefined;
    const content = editsText ? (patch.content ?? null) : row.content;
    let entities: unknown = patch.entities !== undefined ? patch.entities : row.entities;

    /*
     * An edit is a send, and gets the send's rules about what it may claim.
     *
     * `send` refuses `mention_all` from anybody without MENTION_ALL. `edit`
     * wrote whatever it was handed. Nobody was pinged — an edit creates no
     * `message_mentions` rows — but every client draws the chip from the
     * entity, so posting "hi" and editing it into something that looks like it
     * called the whole room was a two-request trick. The guard existed; it was
     * only on one of the two doors into the same column.
     *
     * `extractMentions` is called for its refusal, not its result. Role and
     * person mentions still ride through unfiltered here, exactly as they do
     * on send: the chip renders and nothing rings, which is the same bargain
     * both paths have always made.
     */
    if (patch.entities !== undefined) {
      entities = this.sanitiseEntities(content, entities);
      this.extractMentions(entities as SendMessageInput['entities'], ctx);
    }

    // Same fence as `send`: a card or a button authored by an ordinary account
    // is the most effective phishing surface in the product.
    if (patch.embeds !== undefined || patch.components !== undefined) {
      const [sender] = await db
        .select({ isBot: users.isBot })
        .from(users)
        .where(eq(users.id, actorId))
        .limit(1);
      if (!sender?.isBot) {
        throw forbidden(
          patch.components !== undefined ? 'Only bots can attach buttons' : 'Only bots can post rich embeds',
        );
      }
    }

    if (row.type !== 'text' && editsText && !content) {
      throw unprocessable('Only the caption of a media message can be edited');
    }

    const updated = await db.transaction(async (tx) => {
      /*
       * Keep the previous text: "edited" without history is a moderation
       * hole.
       *
       * Not for a card. A revision answers "what did they say before they
       * changed it", and a card never said anything — it is a slot holding
       * whatever is true now. A ticker on a ten-second refresh would write
       * eight and a half thousand rows a day, forever, none of which any
       * moderator will ever read. What a card is reported for is what it
       * says right now, and that is on the message itself.
       */
      if (!row.cardKey) {
        await tx.execute(
          raw`insert into message_revisions (id, message_id, content, entities, edited_at)
              values (${newId()}::uuid, ${messageId}::uuid, ${row.content}, ${JSON.stringify(row.entities)}::jsonb, now())`,
        );
      }

      const [next] = await tx
        .update(messages)
        .set({
          content,
          entities: (entities ?? null) as never,
          ...(patch.embeds !== undefined ? { embeds: patch.embeds as never } : {}),
          ...(patch.components !== undefined ? { components: patch.components as never } : {}),
          editedAt: new Date(),
        })
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
        .set({
          deletedAt: new Date(),
          deletedById: actorId,
          /*
           * A deleted card gives its name back.
           *
           * Both of these are claims on a name, and a deleted message has
           * no business holding either. `cardKey` is the name the author
           * addresses the card by; `nonce` is the send's idempotency key,
           * which for a card is derived from that same name. Left in place
           * they make the deletion permanent in the one way nobody wants:
           * the bot's next `set` finds no live card, falls through to a
           * send, and the send matches the dead nonce and quietly returns
           * the deleted message. The feed goes on running and publishes
           * into nothing.
           *
           * Cleared, the next write puts up a fresh card — which is the
           * behaviour a name promises. Someone who wants a card gone for
           * good removes the bot's permission to post; that answers 403,
           * and a feed stops on a 403.
           */
          ...(row.cardKey ? { cardKey: null, nonce: null } : {}),
        })
        .where(eq(messages.id, messageId));

      await tx
        .delete(pinnedMessages)
        .where(eq(pinnedMessages.messageId, messageId));

      /*
       * Give the count back.
       *
       * The increment is a database trigger (sync_thread_count, AFTER INSERT
       * — see packages/db/sql/0002_triggers.sql), and it has no delete half:
       * a reply here is a soft delete, which is an UPDATE the trigger never
       * sees. So this is the one side of the bookkeeping the application
       * owns, and it must not also do the other — doing both counts every
       * reply twice.
       *
       * Guarded at zero because the root's own deletion
       * does not walk its replies — a thread whose root goes first would
       * otherwise drive its (now unreachable) counter negative.
       */
      if (row.threadRootId) {
        await tx
          .update(messages)
          .set({ threadReplyCount: raw`greatest(${messages.threadReplyCount} - 1, 0)` })
          .where(eq(messages.id, row.threadRootId));
      }

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
  async hydrateMany(rows: Message[], viewerId: string, deviceId?: string) {
    if (rows.length === 0) return [];
    const { db } = this.deps;

    /**
     * The one ciphertext this device can read.
     *
     * Fetched by `(message, device)`, never by message alone: a client has no
     * business downloading the copies addressed to somebody else, and asking
     * for exactly one row is also the fastest way to ask.
     */
    const encryptedIds = rows.filter((r) => r.isEncrypted).map((r) => r.id);
    const envelopes = new Map<string, string>();
    if (deviceId && encryptedIds.length > 0) {
      const found = await db
        .select({ messageId: messageEnvelopes.messageId, ciphertext: messageEnvelopes.ciphertext })
        .from(messageEnvelopes)
        .where(
          and(
            inArray(messageEnvelopes.messageId, encryptedIds),
            eq(messageEnvelopes.deviceId, deviceId),
          ),
        );
      for (const row of found) envelopes.set(row.messageId, row.ciphertext);
    }

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
              ...publicUserColumns,
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

    /*
     * Where the roles are.
     *
     * A space holds membership and roles; a channel holds only messages. This
     * used to read the page's own conversation id, which in a channel matches
     * no role rows at all — so nobody in a channel had a role colour or a role
     * name on their messages, in a product whose groups are mostly channels.
     */
    const roleScope = rows[0]
      ? ((
          await db
            .select({ parentId: conversations.parentId, id: conversations.id })
            .from(conversations)
            .where(eq(conversations.id, rows[0].conversationId))
            .limit(1)
        )[0] ?? null)
      : null;
    const roleConversationId = roleScope?.parentId ?? roleScope?.id ?? null;

    /**
     * Name colours for this page's senders.
     *
     * A separate query rather than another join on the sender lookup: a member
     * can hold several roles, and joining would multiply the sender rows and
     * force a de-duplication pass. One small indexed read is simpler and, for a
     * page of at most a few dozen distinct senders, cheaper.
     */
    const roleRows =
      senderIds.length && roleConversationId
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
                eq(memberRoles.conversationId, roleConversationId),
                inArray(memberRoles.userId, senderIds),
              ),
            )
            .orderBy(desc(conversationRoles.position))
        : [];

    /*
     * Names and colours for any role the messages call by name.
     *
     * Same query shape, different direction: above is "which roles does this
     * sender hold", this is "what is the role this message named". Both are
     * scoped to the space, because that is where roles live.
     */
    const mentionedRoleIds = [
      ...new Set(
        rows.flatMap((r) =>
          ((r.entities as MessageEntity[] | null) ?? [])
            .filter((e) => e.type === 'mention_role')
            .map((e) => e.roleId),
        ),
      ),
    ];
    const mentionedRoleRows =
      mentionedRoleIds.length && roleConversationId
        ? await db
            .select({
              id: conversationRoles.id,
              name: conversationRoles.name,
              color: conversationRoles.color,
            })
            .from(conversationRoles)
            .where(
              and(
                eq(conversationRoles.conversationId, roleConversationId),
                inArray(conversationRoles.id, mentionedRoleIds),
              ),
            )
        : [];
    const mentionedRoleById = new Map(
      mentionedRoleRows.map((r) => [r.id, { name: r.name, color: r.color }]),
    );

    /*
     * Channel signposts, resolved to titles the reader is allowed to know.
     *
     * Scoped to this space and filtered through `can_view_conversation`, so a
     * `#ticket-mark` typed by staff in a room somebody else can read does not
     * hand that reader the name of a channel they have no access to. An
     * unresolved id renders as the literal text, which is exactly what a
     * client shows for a deleted channel — one fallback, two reasons.
     */
    const mentionedChannelIds = [
      ...new Set(
        rows.flatMap((r) =>
          ((r.entities as MessageEntity[] | null) ?? [])
            .filter((e) => e.type === 'mention_channel')
            .map((e) => e.channelId),
        ),
      ),
    ];
    const mentionedChannelRows =
      mentionedChannelIds.length && roleConversationId
        ? ((await db.execute(
            raw`select c.id, c.title
                  from conversations c
                 where c.id = any(${uuidArray(mentionedChannelIds)})
                   and c.parent_id = ${roleConversationId}::uuid
                   and c.deleted_at is null
                   and can_view_conversation(c.id, ${viewerId}::uuid)`,
          )) as unknown as Array<{ id: string; title: string | null }>)
        : [];
    const mentionedChannelById = new Map(
      mentionedChannelRows.map((r) => [r.id, { title: r.title ?? 'channel' }]),
    );

    /*
     * The group's own emoji, resolved to pictures.
     *
     * Scoped to this conversation and its space, which is the same scope the
     * picker offers: emoji belong to a group, and a space's belong to every
     * channel in it. No visibility check beyond that, unlike channel
     * signposts — an emoji is a picture with a name, not a room, and knowing
     * a group has a `:party_parrot:` reveals nothing about who is in what.
     *
     * The narrowing that does matter is the scope itself. A forwarded message
     * still carries the ids of the group it came from, and those resolve to
     * nothing here, so it renders as `:name:` rather than borrowing a picture
     * from a group this reader was never in.
     */
    const emojiIds = [
      ...new Set(
        rows.flatMap((r) =>
          ((r.entities as MessageEntity[] | null) ?? [])
            .filter((e) => e.type === 'custom_emoji')
            .map((e) => e.emojiId),
        ),
      ),
    ];
    const emojiRows = emojiIds.length
      ? await db
          .select({
            id: customEmojis.id,
            name: customEmojis.name,
            animated: customEmojis.animated,
            objectKey: media.objectKey,
          })
          .from(customEmojis)
          .innerJoin(media, eq(media.id, customEmojis.mediaId))
          .where(
            and(
              inArray(customEmojis.id, emojiIds),
              isNull(customEmojis.deletedAt),
              inArray(
                customEmojis.conversationId,
                // This room and its space: a channel uses its space's emoji,
                // which is the same scope the picker offers.
                [roleScope?.id, roleConversationId].filter((v): v is string => Boolean(v)),
              ),
            ),
          )
      : [];
    const emojiById = new Map(
      emojiRows.map((r) => [
        r.id,
        { name: r.name, url: mediaUrl(r.objectKey), animated: r.animated },
      ]),
    );

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

    // A yappy invite among the links becomes the group it points at. One query
    // for the whole page, and only when a page actually contains one — the
    // common case is no invites at all and no extra query.
    const inviteCodes = previewRows
      .map((p) => inviteCodeFromUrl(p.url))
      .filter((c): c is string => c !== null);
    const inviteCards = await resolveInviteCards(this.deps.db, inviteCodes);

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
        ciphertext: envelopes.get(row.id) ?? null,
        systemNames: namesFor(systemActorIds(row), (id) => {
          const u = senderById.get(id);
          return u ? (u.displayName ?? u.username ?? null) : null;
        }),
        mentionedRoles: rolesFor(row, mentionedRoleById),
        mentionedChannels: channelsFor(row, mentionedChannelById),
        customEmojis: emojiFor(row, emojiById),
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
        linkPreviews: (previewsByMessage.get(row.id) ?? []).map((p) => {
          const code = inviteCodeFromUrl(p.url);
          return {
            url: p.url,
            title: p.title,
            description: p.description,
            siteName: p.siteName,
            imageKey: p.imageKey,
            /**
             * Additive, and left null for every ordinary link.
             *
             * The five fields above are untouched on purpose: a client that
             * has never heard of this one — every build already in the wild,
             * including the one sitting in App Review — keeps rendering the
             * preview it renders today. Nothing it decodes has changed shape.
             */
            invite: (code && inviteCards.get(code)) || null,
          };
        }),
      });
    });
  }

  async hydrateOne(row: Message, viewerId: string, overrides: MessageExtras = {}) {
    if (Object.keys(overrides).length > 0) {
      const [sender] = row.senderId
        ? await this.deps.db
            .select({
              ...publicUserColumns,
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
        ...(await this.roleExtras(row)),
        ...(await this.emojiExtras(row)),
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

  /**
   * Role names and colours for a single message, in one query.
   *
   * `hydrateOne` takes a short path when it is given overrides, which is
   * every send — so this is the version of what `hydrateMany` does in bulk.
   * Without it a message arriving live has no role colour on its author and
   * no name on a `@role` it mentions, and both appear out of nowhere on the
   * next reload, which reads as a rendering bug.
   *
   * One query rather than three: the roles a sender holds and the roles a
   * message names are rows in the same table, scoped the same way, so a
   * left join answers both. Cheap enough to sit on the send path, which is
   * the reason it is shaped like this at all.
   */
  /**
   * Pictures for the emoji a freshly-sent message names.
   *
   * The POST response and the gateway event are built on a fast path that
   * skips `hydrateMany`, so without this a message you have just sent — and
   * one arriving live for everybody else — carries the entity but no picture,
   * and every client falls back to `:party_parrot:` until the next refetch.
   * Sending it looked like it had not worked.
   *
   * Safe to put on the shared payload, unlike a channel signpost: emoji
   * visibility is not per-reader. Anyone who can see the message is in the
   * conversation, and an emoji of that conversation or its space is exactly
   * what they are entitled to resolve. `hydrateMany` scopes it the same way.
   */
  private async emojiExtras(row: Message): Promise<MessageExtras> {
    const named = [
      ...new Set(
        ((row.entities as MessageEntity[] | null) ?? [])
          .filter((e) => e.type === 'custom_emoji')
          .map((e) => e.emojiId),
      ),
    ];
    if (named.length === 0) return {};

    const rows = (await this.deps.db.execute(raw`
      select e.id, e.name, e.animated, m.object_key
        from custom_emojis e
        join media m on m.id = e.media_id
       where e.id = any(${uuidArray(named)})
         and e.deleted_at is null
         and e.conversation_id in (
               select c.id from conversations c where c.id = ${row.conversationId}::uuid
               union
               select c.parent_id from conversations c
                where c.id = ${row.conversationId}::uuid and c.parent_id is not null
             )
    `)) as unknown as Array<{
      id: string;
      name: string;
      animated: boolean;
      object_key: string;
    }>;

    return {
      customEmojis: emojiFor(
        row,
        new Map(
          rows.map((r) => [
            r.id,
            { name: r.name, url: mediaUrl(r.object_key), animated: r.animated },
          ]),
        ),
      ),
    };
  }

  private async roleExtras(row: Message): Promise<MessageExtras> {
    const named = [
      ...new Set(
        ((row.entities as MessageEntity[] | null) ?? [])
          .filter((e) => e.type === 'mention_role')
          .map((e) => e.roleId),
      ),
    ];
    if (!row.senderId && named.length === 0) return {};

    const rows = (await this.deps.db.execute(raw`
      select r.id, r.name, r.color, (mr.user_id is not null) as held
        from conversation_roles r
        left join member_roles mr
          on mr.role_id = r.id
         and mr.conversation_id = r.conversation_id
         and mr.user_id = ${row.senderId ?? null}::uuid
       where r.conversation_id = (
               select coalesce(c.parent_id, c.id) from conversations c where c.id = ${row.conversationId}::uuid
             )
         and (mr.user_id is not null or r.id = any(${uuidArray(named)}))
       order by r.position desc
    `)) as unknown as Array<{ id: string; name: string; color: string | null; held: boolean }>;

    const held = rows.filter((r) => r.held);
    return {
      senderRoleName: held[0]?.name ?? null,
      senderRoleColor: held.find((r) => r.color)?.color ?? null,
      mentionedRoles: rolesFor(
        row,
        new Map(rows.map((r) => [r.id, { name: r.name, color: r.color }])),
      ),
    };
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

  /**
   * Who a message is addressed to, and how widely.
   *
   * Three kinds, and they are not the same thing to the person receiving
   * one. A direct mention is somebody using your name. A role mention is a
   * group you belong to being called. `@everyone` is the room. Clients
   * style them differently and `is_broadcast` is what tells them apart, so
   * the distinction has to survive the fan-out rather than collapsing into
   * one list of ids here.
   */
  /**
   * Entities that actually describe the text they are attached to.
   *
   * Nothing checked this. An entity could point past the end of the message,
   * carry a negative offset, or overlap the one before it — and each client
   * had grown its own defence against that, three separate mitigations for a
   * thing the server could settle once. iOS drops out-of-range spans, Android
   * drops them, web slices around them; none of them agree about overlaps.
   *
   * Bad entities are dropped rather than refused, and that is a deliberate
   * choice about blast radius. Three shipped clients compute these offsets,
   * and rejecting the send would mean somebody's message is lost because of a
   * rounding error in the version of the app they happen to have. Dropping the
   * span costs a chip and keeps the sentence.
   *
   * Offsets are UTF-16 code units, which is what `String.length` counts here,
   * what Kotlin indexes by, and what iOS converts to before sending.
   */
  private sanitiseEntities(content: string | null | undefined, entities: unknown): unknown {
    const list = (entities as MessageEntity[] | null | undefined) ?? [];
    if (list.length === 0) return entities;
    const limit = content?.length ?? 0;
    const kept: MessageEntity[] = [];
    let end = 0;
    // Sorted, because "overlapping" is only answerable in order — and every
    // renderer walks them in order anyway.
    for (const e of [...list].sort((a, b) => a.offset - b.offset)) {
      if (!Number.isInteger(e.offset) || !Number.isInteger(e.length)) continue;
      if (e.offset < 0 || e.length <= 0) continue;
      if (e.offset + e.length > limit) continue;
      if (e.offset < end) continue;
      kept.push(e);
      end = e.offset + e.length;
    }
    return kept;
  }

  private extractMentions(
    entities: SendMessageInput['entities'],
    ctx: MemberContext,
  ): { userIds: string[]; roleIds: string[]; broadcast: boolean } {
    const ids = new Set<string>();
    const roleIds = new Set<string>();
    let broadcast = false;
    for (const e of entities ?? []) {
      if (e.type === 'mention') ids.add(e.userId);
      if (e.type === 'mention_role') roleIds.add(e.roleId);
      if (e.type === 'mention_all') {
        if (!has(ctx.permissions, Permission.MENTION_ALL)) {
          throw unprocessable('You cannot mention everyone in this conversation');
        }
        broadcast = true;
      }
    }
    return { userIds: [...ids], roleIds: [...roleIds], broadcast };
  }

  /**
   * Of the people this message names, the ones who can actually see it.
   *
   * `extractMentions` reads ids straight out of client-supplied entities, and
   * for a long time that list went to the insert untouched — no membership
   * check, no visibility check, nothing. Two consequences, and the second is
   * the bad one. A mention row drives the red badge (the `mentions_bump`
   * trigger) and a push, so naming somebody who cannot see the channel rang
   * their phone about a room they are not in. And `GET /users/me/mentions`
   * hydrates the message, so the ping came with the text attached.
   *
   * Filtered here rather than inside the transaction because the answer also
   * feeds the push fan-out, and the two must not be able to disagree about
   * who was called.
   *
   * A named non-viewer is dropped silently rather than refused. The message
   * itself is fine and the sender is usually not up to anything — the picker
   * offers everyone in the space — so a 422 would punish the wrong person for
   * a gap in the client. Their name still renders; it just does not ring.
   */
  private async visibleMentionIds(conversationId: string, ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = (await this.deps.db.execute(
      raw`select v.user_id
            from conversation_viewers(${conversationId}::uuid) v
           where v.user_id = any(${uuidArray(ids)})`,
    )) as unknown as Array<{ user_id: string }>;
    const visible = new Set(rows.map((r) => r.user_id));
    return ids.filter((id) => visible.has(id));
  }

  /**
   * Which of the named roles this sender is allowed to ping.
   *
   * `isMentionable` is the role's own answer: a role marked mentionable can
   * be called by anyone who can speak here, which is the point of marking
   * it. One that isn't takes `MENTION_ALL`, the same permission `@everyone`
   * needs — because pinging every moderator is the same act as pinging the
   * room, just aimed.
   *
   * A role from another space is dropped rather than refused. It is a
   * client bug, not an attack, and the message itself is fine.
   */
  private async mentionableRoles(
    ctx: MemberContext,
    roleIds: string[],
  ): Promise<string[]> {
    if (roleIds.length === 0) return [];
    const scope = ctx.conversation.parentId ?? ctx.conversation.id;
    const rows = await this.deps.db
      .select({ id: conversationRoles.id, isMentionable: conversationRoles.isMentionable })
      .from(conversationRoles)
      .where(
        and(eq(conversationRoles.conversationId, scope), inArray(conversationRoles.id, roleIds)),
      );

    const mayPingAny = has(ctx.permissions, Permission.MENTION_ALL);
    return rows.filter((r) => mayPingAny || r.isMentionable).map((r) => r.id);
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
