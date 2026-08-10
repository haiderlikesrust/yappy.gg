import {
  and,
  conversationBans,
  conversationMembers,
  conversations,
  desc,
  eq,
  inArray,
  isNull,
  media,
  messages,
  sql as raw,
  users,
  uuidArray,
  type Conversation,
  type Database,
  type Executor,
} from '@yappy/db';
import {
  Event,
  LIMITS,
  Permission,
  conflict,
  dmKey as buildDmKey,
  ErrorCode,
  effectivePermissions,
  forbidden,
  historyFloor,
  newId,
  notFound,
  type ConversationType,
  type MemberRole,
  type SystemEvent,
} from '@yappy/shared';
import { assertCanInitiate, requireMember } from '../lib/access.js';
import type { EventPublisher } from '../lib/events.js';
import { txExecutor } from '../lib/events.js';
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
import { toConversation, toPublicUser, type PublicUser } from '../lib/serialize.js';
import { buildPreview } from './messages.js';

export interface ConversationServiceDeps {
  db: Database;
  events: EventPublisher;
  enqueue: (name: string, data: Record<string, unknown>) => Promise<void>;
}

export class ConversationService {
  constructor(private readonly deps: ConversationServiceDeps) {}

  /**
   * Create a conversation.
   *
   * For DMs this is idempotent by construction: the `dm_key` unique index means
   * two simultaneous "message this person" taps resolve to the same row, and
   * the loser of the race reads the winner's conversation rather than erroring.
   */
  async create(
    actorId: string,
    input: {
      type: ConversationType;
      memberIds: string[];
      title?: string | null;
      description?: string | null;
      avatarMediaId?: string | null;
      disappearingSeconds: number;
    },
  ): Promise<{ conversation: ReturnType<typeof toConversation>; created: boolean }> {
    const { db, events } = this.deps;

    if (input.type === 'dm') {
      const otherId = input.memberIds[0]!;
      if (otherId === actorId) throw conflict('You cannot DM yourself');
      await assertCanInitiate(db, otherId, actorId, 'dm');

      const key = buildDmKey(actorId, otherId);
      const [existing] = await db
        .select()
        .from(conversations)
        .where(and(eq(conversations.dmKey, key), isNull(conversations.deletedAt)))
        .limit(1);

      if (existing) {
        // Re-open the thread if either side had left it.
        await db
          .update(conversationMembers)
          .set({ leftAt: null })
          .where(eq(conversationMembers.conversationId, existing.id));
        return { conversation: await this.view(existing.id, actorId), created: false };
      }

      const id = newId();
      try {
        await db.transaction(async (tx) => {
          await tx.insert(conversations).values({
            id,
            type: 'dm',
            dmKey: key,
            createdById: actorId,
            disappearingSeconds: input.disappearingSeconds,
          });
          await tx.insert(conversationMembers).values([
            { conversationId: id, userId: actorId, role: 'member' },
            { conversationId: id, userId: otherId, role: 'member' },
          ]);
        });
      } catch (err) {
        // Lost the race on the unique index — fetch the winner.
        if ((err as { code?: string }).code === '23505') {
          const [row] = await db
            .select()
            .from(conversations)
            .where(eq(conversations.dmKey, key))
            .limit(1);
          if (row) return { conversation: await this.view(row.id, actorId), created: false };
        }
        throw err;
      }

      const view = await this.view(id, actorId);
      await events.toUsers([actorId, otherId], Event.ConversationCreate, view);
      return { conversation: view, created: true };
    }

    // Group / channel.
    const uniqueMembers = [...new Set(input.memberIds.filter((id) => id !== actorId))];
    if (uniqueMembers.length + 1 > LIMITS.groupMembersMax) {
      throw conflict(`A conversation can hold at most ${LIMITS.groupMembersMax} members`);
    }

    // Anyone who has restricted group-adds, or blocked the creator, is dropped
    // silently rather than failing the whole creation.
    const allowed: string[] = [];
    for (const candidate of uniqueMembers) {
      try {
        await assertCanInitiate(db, candidate, actorId, 'group_add');
        allowed.push(candidate);
      } catch {
        /* skipped */
      }
    }

    const id = newId();
    await db.transaction(async (tx) => {
      await tx.insert(conversations).values({
        id,
        type: input.type,
        title: input.title ?? null,
        description: input.description ?? null,
        avatarMediaId: input.avatarMediaId ?? null,
        ownerId: actorId,
        createdById: actorId,
        disappearingSeconds: input.disappearingSeconds,
      });

      await tx.insert(conversationMembers).values([
        { conversationId: id, userId: actorId, role: 'owner' },
        ...allowed.map((userId) => ({
          conversationId: id,
          userId,
          role: 'member' as const,
          invitedById: actorId,
        })),
      ]);

      await this.writeSystemMessage(tx, id, {
        event: 'conversation_created',
        actorId,
        value: input.title ?? null,
      });
    });

    const view = await this.view(id, actorId);
    await events.toUsers([actorId, ...allowed], Event.ConversationCreate, view);
    return { conversation: view, created: true };
  }

  /** Full conversation payload as one specific viewer sees it. */
  async view(conversationId: string, viewerId: string) {
    const { db } = this.deps;
    const ctx = await requireMember(db, conversationId, viewerId);
    const c = ctx.conversation;

    const [avatarRow] = c.avatarMediaId
      ? await db.select({ key: media.objectKey }).from(media).where(eq(media.id, c.avatarMediaId)).limit(1)
      : [undefined];

    /**
     * A channel's own `member_count` only counts the rows that happen to have
     * been materialised — everyone who has posted or read there — which is not
     * how many people are in it. Membership lives on the space, so the count
     * does too. Reported from the parent rather than kept in sync on the child
     * because there is nothing to sync: the child never had the truth.
     */
    const [parentRow] = c.parentId
      ? await db
          .select({
            memberCount: conversations.memberCount,
            title: conversations.title,
            // A channel has no picture of its own — it wears the space's, the
            // way #general is still recognisably that server.
            avatarKey: media.objectKey,
          })
          .from(conversations)
          .leftJoin(media, eq(media.id, conversations.avatarMediaId))
          .where(eq(conversations.id, c.parentId))
          .limit(1)
      : [undefined];

    let otherUser: PublicUser | null = null;
    let memberPreview: PublicUser[] = [];

    if (c.type === 'dm') {
      const [other] = await db
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
        .from(conversationMembers)
        .innerJoin(users, eq(users.id, conversationMembers.userId))
        .leftJoin(media, eq(media.id, users.avatarMediaId))
        .leftJoin(affiliationGroup, affiliationGroupOn(users.affiliationConversationId))
        .leftJoin(affiliationAvatar, affiliationAvatarOn())
        .leftJoin(affiliationMembership, affiliationMembershipOn(users.id))
        .where(
          and(
            eq(conversationMembers.conversationId, conversationId),
            raw`${conversationMembers.userId} <> ${viewerId}::uuid`,
          ),
        )
        .limit(1);
      if (other) otherUser = toPublicUser(other, other.avatarKey, pickAffiliation(other));
    } else {
      // A handful of faces for the group avatar stack — not the full roster.
      const rows = await db
        .select({
          id: users.id,
          username: users.username,
          displayName: users.displayName,
          isBot: users.isBot,
          isVerified: users.isVerified,
          // No affiliation here: these are 16px stacked faces, and a mark that
          // small is a smudge. Badges only where a name is actually legible.
          badge: users.badge,
          avatarKey: media.objectKey,
        })
        .from(conversationMembers)
        .innerJoin(users, eq(users.id, conversationMembers.userId))
        .leftJoin(media, eq(media.id, users.avatarMediaId))
        .where(
          and(
            // For a channel the faces are the space's, for the same reason the
            // count is.
            eq(conversationMembers.conversationId, c.parentId ?? conversationId),
            isNull(conversationMembers.leftAt),
          ),
        )
        .limit(4);
      memberPreview = rows.map((r) => toPublicUser(r, r.avatarKey));
    }

    return toConversation(c, {
      member: ctx.member,
      permissions: ctx.permissions,
      avatarKey: avatarRow?.key ?? parentRow?.avatarKey ?? null,
      otherUser,
      memberPreview,
      memberCount: parentRow?.memberCount,
      parentTitle: parentRow?.title ?? null,
    });
  }

  // ── Membership ────────────────────────────────────────────────────────────

  async addMembers(actorId: string, conversationId: string, userIds: string[]) {
    const { db, events } = this.deps;
    const ctx = await requireMember(db, conversationId, actorId);

    if (ctx.conversation.type === 'dm') throw conflict('You cannot add people to a DM');
    if (!(ctx.permissions & Permission.INVITE_MEMBERS) && !(ctx.permissions & Permission.ADMINISTRATOR)) {
      throw forbidden('You cannot add members to this conversation');
    }

    const candidates = [...new Set(userIds)];

    const banned = await db
      .select({ userId: conversationBans.userId })
      .from(conversationBans)
      .where(
        and(eq(conversationBans.conversationId, conversationId), inArray(conversationBans.userId, candidates)),
      );
    const bannedSet = new Set(banned.map((b) => b.userId));

    const existing = await db
      .select({ userId: conversationMembers.userId, leftAt: conversationMembers.leftAt })
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          inArray(conversationMembers.userId, candidates),
        ),
      );
    const activeSet = new Set(existing.filter((e) => !e.leftAt).map((e) => e.userId));
    const rejoinSet = new Set(existing.filter((e) => e.leftAt).map((e) => e.userId));

    const added: string[] = [];
    const skipped: Array<{ userId: string; reason: string }> = [];

    for (const userId of candidates) {
      if (bannedSet.has(userId)) {
        skipped.push({ userId, reason: 'banned' });
        continue;
      }
      if (activeSet.has(userId)) {
        skipped.push({ userId, reason: 'already_a_member' });
        continue;
      }
      try {
        await assertCanInitiate(db, userId, actorId, 'group_add');
        added.push(userId);
      } catch {
        skipped.push({ userId, reason: 'privacy' });
      }
    }

    if (ctx.conversation.memberCount + added.length > LIMITS.groupMembersMax) {
      throw conflict('This conversation is full');
    }

    if (added.length > 0) {
      await db.transaction(async (tx) => {
        const rejoining = added.filter((id) => rejoinSet.has(id));
        const fresh = added.filter((id) => !rejoinSet.has(id));

        if (rejoining.length > 0) {
          await tx
            .update(conversationMembers)
            .set({ leftAt: null, invitedById: actorId, role: 'member' })
            .where(
              and(
                eq(conversationMembers.conversationId, conversationId),
                inArray(conversationMembers.userId, rejoining),
              ),
            );
        }

        if (fresh.length > 0) {
          await tx.insert(conversationMembers).values(
            fresh.map((userId) => ({
              conversationId,
              userId,
              role: 'member' as const,
              invitedById: actorId,
              // New members start at the current head unless the group has
              // opted into showing its backlog.
              historyStartSeq: historyFloor(
                ctx.conversation.historyVisibility,
                ctx.conversation.messageSeq,
              ),
            })),
          );
        }

        await this.writeSystemMessage(tx, conversationId, {
          event: 'member_added',
          actorId,
          targetIds: added,
        });

        await events.toConversation(
          conversationId,
          Event.MemberAdd,
          { conversationId, userIds: added, actorId },
          { exec: txExecutor(tx) },
        );
      });

      const view = await this.view(conversationId, actorId);
      await events.toUsers(added, Event.ConversationCreate, view);
    }

    return { added, skipped };
  }

  async removeMember(actorId: string, conversationId: string, targetId: string) {
    const { db, events } = this.deps;
    const ctx = await requireMember(db, conversationId, actorId);
    const isSelf = actorId === targetId;

    if (ctx.conversation.type === 'dm') throw conflict('You cannot remove people from a DM');

    if (!isSelf) {
      if (!(ctx.permissions & Permission.KICK_MEMBERS) && !(ctx.permissions & Permission.ADMINISTRATOR)) {
        throw forbidden('You cannot remove members');
      }
      const [target] = await db
        .select({ role: conversationMembers.role })
        .from(conversationMembers)
        .where(
          and(
            eq(conversationMembers.conversationId, conversationId),
            eq(conversationMembers.userId, targetId),
          ),
        )
        .limit(1);
      if (!target) throw notFound('Member');
      const { outranks } = await import('@yappy/shared');
      if (!outranks(ctx.member.role as MemberRole, target.role as MemberRole)) {
        throw forbidden('That member has an equal or higher role than you');
      }
    }

    if (isSelf && ctx.member.role === 'owner' && ctx.conversation.memberCount > 1) {
      throw conflict('Transfer ownership before leaving this group');
    }

    await db.transaction(async (tx) => {
      await tx
        .update(conversationMembers)
        .set({ leftAt: new Date() })
        .where(
          and(
            eq(conversationMembers.conversationId, conversationId),
            eq(conversationMembers.userId, targetId),
          ),
        );

      await this.writeSystemMessage(tx, conversationId, {
        event: isSelf ? 'member_left' : 'member_removed',
        actorId,
        targetIds: [targetId],
      });

      await events.toConversation(
        conversationId,
        Event.MemberRemove,
        { conversationId, userId: targetId, actorId },
        { exec: txExecutor(tx) },
      );
    });

    // The removed member's own client needs the event on their user topic —
    // their gateway drops the conversation subscription immediately.
    await events.toUser(targetId, Event.ConversationDelete, { id: conversationId, reason: isSelf ? 'left' : 'removed' });

    return { removed: true };
  }

  // ── System messages ───────────────────────────────────────────────────────

  /**
   * Group activity ("Alex added Sam") is stored as a real message.
   *
   * The alternative — a separate activity table — means the client has to merge
   * two ordered streams to render one timeline, and gets the interleaving wrong
   * at page boundaries. As messages they share the `seq` space and Just Work.
   */
  async writeSystemMessage(
    tx: Executor,
    conversationId: string,
    payload: { event: SystemEvent; actorId?: string; targetIds?: string[]; value?: string | null },
  ) {
    const seqRows = (await tx.execute(
      raw`select allocate_message_seq(${conversationId}::uuid) as seq`,
    )) as unknown as Array<{ seq: string | number }>;
    const seq = Number(seqRows[0]!.seq);
    const id = newId();

    await tx.insert(messages).values({
      id,
      conversationId,
      seq,
      senderId: null,
      type: 'system',
      system: payload,
    });

    await tx
      .update(conversations)
      .set({
        lastMessageId: id,
        lastMessageAt: new Date(),
        lastMessagePreview: buildPreview('system', null, false),
      })
      .where(eq(conversations.id, conversationId));

    return { id, seq };
  }

  // ── Listing ───────────────────────────────────────────────────────────────

  /**
   * The conversation list.
   *
   * Everything the list screen renders is denormalised onto `conversations`
   * (last message preview, timestamp, member count) or onto the member row
   * (unread, mention count), so this is one indexed scan plus a lookup for
   * avatars — not a per-row subquery for the latest message.
   */
  async list(
    viewerId: string,
    opts: { limit: number; before?: string; archived: boolean },
  ) {
    const { db } = this.deps;

    const rows = await db
      .select({ conversation: conversations, member: conversationMembers })
      .from(conversationMembers)
      .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
      .where(
        and(
          eq(conversationMembers.userId, viewerId),
          isNull(conversationMembers.leftAt),
          isNull(conversations.deletedAt),
          // Channels belong to their space's screen, not the home list. A
          // member row exists for any channel someone has opened, so without
          // this the list would slowly fill with them.
          isNull(conversations.parentId),
          eq(conversationMembers.isArchived, opts.archived),
          opts.before ? raw`${conversations.lastMessageAt} < ${opts.before}::timestamptz` : undefined,
        ),
      )
      .orderBy(desc(conversationMembers.isPinned), desc(conversations.lastMessageAt))
      .limit(opts.limit);

    if (rows.length === 0) return { conversations: [], nextCursor: null };

    const ids = rows.map((r) => r.conversation.id);
    const dmIds = rows.filter((r) => r.conversation.type === 'dm').map((r) => r.conversation.id);
    const groupIds = rows.filter((r) => r.conversation.type !== 'dm').map((r) => r.conversation.id);

    const [otherUsers, avatars, lastMessages, hereCounts] = await Promise.all([
      dmIds.length
        ? db
            .select({
              conversationId: conversationMembers.conversationId,
              id: users.id,
              username: users.username,
              displayName: users.displayName,
              isBot: users.isBot,
              isVerified: users.isVerified,
              badge: users.badge,
              avatarKey: media.objectKey,
              ...affiliationColumns,
            })
            .from(conversationMembers)
            .innerJoin(users, eq(users.id, conversationMembers.userId))
            .leftJoin(media, eq(media.id, users.avatarMediaId))
            .leftJoin(affiliationGroup, affiliationGroupOn(users.affiliationConversationId))
            .leftJoin(affiliationAvatar, affiliationAvatarOn())
            .leftJoin(affiliationMembership, affiliationMembershipOn(users.id))
            .where(
              and(
                inArray(conversationMembers.conversationId, dmIds),
                raw`${conversationMembers.userId} <> ${viewerId}::uuid`,
              ),
            )
        : Promise.resolve([]),
      db
        .select({ conversationId: conversations.id, key: media.objectKey })
        .from(conversations)
        .innerJoin(media, eq(media.id, conversations.avatarMediaId))
        .where(inArray(conversations.id, ids)),
      db
        .select({
          conversationId: messages.conversationId,
          id: messages.id,
          seq: messages.seq,
          type: messages.type,
          senderId: messages.senderId,
          content: messages.content,
          createdAt: messages.createdAt,
          deletedAt: messages.deletedAt,
        })
        .from(messages)
        .where(
          inArray(
            messages.id,
            rows.map((r) => r.conversation.lastMessageId).filter((v): v is string => Boolean(v)),
          ),
        ),
      // "Who is here right now", per group. This is the list's pulse — a group
      // with people in it should feel alive before it is even opened.
      groupIds.length
        ? (db.execute(
            raw`select m.conversation_id, count(distinct p.user_id)::int as here
                  from presence p
                  join conversation_members m
                    on m.user_id = p.user_id and m.left_at is null
                 where p.expires_at > now()
                   and m.conversation_id = any(${uuidArray(groupIds)})
                 group by m.conversation_id`,
          ) as Promise<unknown> as Promise<Array<{ conversation_id: string; here: number }>>)
        : Promise.resolve([] as Array<{ conversation_id: string; here: number }>),
    ]);

    const otherByConv = new Map(otherUsers.map((u) => [u.conversationId, u]));
    const avatarByConv = new Map(avatars.map((a) => [a.conversationId, a.key]));
    const lastByConv = new Map(lastMessages.map((m) => [m.conversationId, m]));
    const hereByConv = new Map(hereCounts.map((h) => [h.conversation_id, h.here]));

    const list = rows.map(({ conversation: c, member: m }) => {
      const other = otherByConv.get(c.id);
      const last = lastByConv.get(c.id);
      const permissions = effectivePermissions({
        conversationType: c.type,
        basePermissions: c.basePermissions,
        role: m.role as MemberRole,
        allow: m.allow,
        deny: m.deny,
        mutedUntil: m.mutedUntil,
      });

      return toConversation(c, {
        member: m,
        permissions,
        hereCount: hereByConv.get(c.id) ?? 0,
        avatarKey: avatarByConv.get(c.id) ?? null,
        otherUser: other ? toPublicUser(other, other.avatarKey, pickAffiliation(other)) : null,
        lastMessage: last
          ? ({
              id: last.id,
              seq: last.seq,
              type: last.type,
              senderId: last.senderId,
              preview: last.deletedAt ? null : c.lastMessagePreview,
              createdAt: last.createdAt.toISOString(),
            } as never)
          : null,
      });
    });

    const oldest = rows.at(-1)?.conversation.lastMessageAt ?? null;
    return {
      conversations: list,
      nextCursor: rows.length === opts.limit && oldest ? oldest.toISOString() : null,
    };
  }
}
