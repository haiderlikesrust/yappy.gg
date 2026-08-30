import {
  alias,
  and,
  blocks,
  conversationMembers,
  conversations,
  eq,
  follows,
  inArray,
  isNull,
  or,
  sql as raw,
  users,
  type Conversation,
  type ConversationMember,
  type Database,
  type Executor,
} from '@yappy/db';
import {
  ErrorCode,
  Permission,
  effectivePermissions,
  forbidden,
  has,
  missingPermission,
  notFound,
  outranks,
  parsePermissions,
  permissionNames,
  type MemberRole,
  type PrivacyAudience,
} from '@yappy/shared';
import { AppError } from '@yappy/shared';

/**
 * Every authorisation decision in the API funnels through this module.
 *
 * The rule is: a route handler never reads `conversation_members` directly to
 * decide whether something is allowed. It calls `requireMember` or
 * `requirePermission`, which return the membership row the handler then uses.
 * One place to audit, one place to fix.
 */

/** The space's membership row, joined alongside the channel's own. */
const parentMembers = alias(conversationMembers, 'parent_members');

export interface MemberContext {
  conversation: Conversation;
  /**
   * The row carrying this viewer's per-conversation state — read cursor,
   * nickname, notification level.
   *
   * For a channel this is the channel's own row when one exists. It may be
   * synthesised from the space's row for a member who has never opened the
   * channel: membership of a space is membership of its channels, and
   * materialising a row per (member × channel) at join time would mean
   * thousands of writes for something most people never read.
   */
  member: ConversationMember;
  /**
   * True when `member` was synthesised rather than read. Callers that persist
   * state — a read acknowledgement, a draft — must upsert rather than update.
   */
  memberIsVirtual: boolean;
  permissions: bigint;
}

export async function loadMemberContext(
  db: Database,
  conversationId: string,
  userId: string,
): Promise<MemberContext | null> {
  const [row] = await db
    .select({
      conversation: conversations,
      member: conversationMembers,
      /**
       * The space's membership row, for a channel. This is where a channel's
       * *authority* comes from — role, allow/deny, mute — so that promoting
       * someone in a space promotes them everywhere in it, with nothing to
       * keep in sync and no way for the two to drift.
       */
      parentMember: parentMembers,
      /**
       * Named roles, folded in as a correlated subselect rather than a second
       * query. This function runs on every authorised request in the app, so
       * "roles cost one extra round trip" would have meant "roles cost one
       * extra round trip on every message send". `bit_or` unions the
       * bitfields in the database and returns a single int8.
       *
       * Scoped to the space for a channel: roles are defined once per space.
       */
      rolePermissions: raw<string>`(
        select coalesce(bit_or(r.permissions), 0)::text
          from member_roles mr
          join conversation_roles r on r.id = mr.role_id
         where mr.conversation_id = coalesce(${conversations.parentId}, ${conversations.id})
           and mr.user_id = ${userId}::uuid
      )`,
      /**
       * What this channel says about the roles this member holds.
       *
       * The same correlated-subselect trick and for the same reason, but
       * scoped to *this* conversation rather than the space: an overwrite is
       * a statement about one channel. Roles are the space's, so the join
       * still reaches through the parent to find which ones this member has.
       *
       * Two columns rather than one because allow and deny compose
       * differently across several roles — see `effectivePermissions`.
       */
      roleAllow: raw<string>`(
        select coalesce(bit_or(o.allow), 0)::text
          from conversation_role_overwrites o
          join member_roles mr on mr.role_id = o.role_id
         where o.conversation_id = ${conversations.id}
           and mr.conversation_id = coalesce(${conversations.parentId}, ${conversations.id})
           and mr.user_id = ${userId}::uuid
      )`,
      roleDeny: raw<string>`(
        select coalesce(bit_or(o.deny), 0)::text
          from conversation_role_overwrites o
          join member_roles mr on mr.role_id = o.role_id
         where o.conversation_id = ${conversations.id}
           and mr.conversation_id = coalesce(${conversations.parentId}, ${conversations.id})
           and mr.user_id = ${userId}::uuid
      )`,
    })
    .from(conversations)
    .leftJoin(
      conversationMembers,
      and(
        eq(conversationMembers.conversationId, conversations.id),
        eq(conversationMembers.userId, userId),
      ),
    )
    .leftJoin(
      parentMembers,
      and(eq(parentMembers.conversationId, conversations.parentId), eq(parentMembers.userId, userId)),
    )
    .where(and(eq(conversations.id, conversationId), isNull(conversations.deletedAt)))
    .limit(1);

  if (!row) return null;

  // Authority: the space's row for a channel, the conversation's own otherwise.
  const authority = row.conversation.parentId ? row.parentMember : row.member;
  if (!authority || authority.leftAt) return null;

  // State: the channel's own row, or a stand-in derived from the space's so a
  // member who has never opened this channel still reads as a member.
  const memberIsVirtual = !row.member;
  const member: ConversationMember = row.member ?? {
    ...authority,
    conversationId: row.conversation.id,
    lastReadSeq: 0,
    lastReadAt: null,
    lastDeliveredSeq: 0,
    mentionCount: 0,
    // A member joining a space sees its channels from the beginning; the
    // per-channel floor only means something once they have their own row.
    historyStartSeq: 0,
    draft: null,
    draftUpdatedAt: null,
    isPinned: false,
    isArchived: false,
  };

  const permissions = effectivePermissions({
    conversationType: row.conversation.type,
    basePermissions: row.conversation.basePermissions,
    role: authority.role as MemberRole,
    rolePermissions: parsePermissions(row.rolePermissions),
    roleAllow: parsePermissions(row.roleAllow),
    roleDeny: parsePermissions(row.roleDeny),
    // Channel-level allow/deny still applies when a real row exists: that is
    // how one person gets muted in #general but not everywhere.
    allow: (row.member?.allow ?? 0n) | (row.conversation.parentId ? authority.allow : 0n),
    deny: (row.member?.deny ?? 0n) | (row.conversation.parentId ? authority.deny : 0n),
    mutedUntil: row.member?.mutedUntil ?? authority.mutedUntil,
  });

  return { conversation: row.conversation, member, memberIsVirtual, permissions };
}

/**
 * Give a space member their own row in one of its channels.
 *
 * `loadMemberContext` can *read* a channel membership that has no row, but the
 * moment something needs to be written down — a read cursor, a draft, a mute —
 * the row has to exist. Idempotent, and a no-op for anything that is not a
 * channel, so callers can invoke it without first working out which case they
 * are in.
 *
 * The role is copied from the space only as a starting value; authority is
 * always re-read from the space, so a later promotion there is not stranded by
 * this snapshot.
 */
export async function materialiseChannelMember(
  exec: Executor,
  conversationId: string,
  userId: string,
): Promise<void> {
  await exec.execute(raw`
    insert into conversation_members (conversation_id, user_id, role, joined_at, history_start_seq)
    select c.id, ${userId}::uuid, pm.role, now(), 0
      from conversations c
      join conversation_members pm
        on pm.conversation_id = c.parent_id
       and pm.user_id = ${userId}::uuid
       and pm.left_at is null
     where c.id = ${conversationId}::uuid and c.parent_id is not null
    on conflict (conversation_id, user_id) do nothing
  `);
}

export async function requireMember(
  db: Database,
  conversationId: string,
  userId: string,
): Promise<MemberContext> {
  const ctx = await loadMemberContext(db, conversationId, userId);
  if (!ctx) {
    // Deliberately 404, not 403: confirming a conversation exists to a
    // non-member leaks group membership to anyone who can guess an id.
    throw notFound('Conversation');
  }
  return ctx;
}

export async function requirePermission(
  db: Database,
  conversationId: string,
  userId: string,
  permission: bigint,
): Promise<MemberContext> {
  const ctx = await requireMember(db, conversationId, userId);
  if (!has(ctx.permissions, permission)) {
    const [name] = permissionNames(permission);
    throw missingPermission(name ?? 'unknown');
  }
  return ctx;
}

/** Acting on another member requires strictly higher rank. */
export function requireOutranks(actor: MemberRole, target: MemberRole): void {
  if (!outranks(actor, target)) {
    throw forbidden('That member has an equal or higher role than you');
  }
}

// ─── Interpersonal gates ─────────────────────────────────────────────────────

/** True if either direction of a block exists. */
export async function isBlockedEitherWay(db: Database, a: string, b: string): Promise<boolean> {
  const [row] = await db
    .select({ blockerId: blocks.blockerId })
    .from(blocks)
    .where(
      or(
        and(eq(blocks.blockerId, a), eq(blocks.blockedId, b)),
        and(eq(blocks.blockerId, b), eq(blocks.blockedId, a)),
      ),
    )
    .limit(1);
  return Boolean(row);
}

export async function assertNotBlocked(db: Database, a: string, b: string): Promise<void> {
  if (await isBlockedEitherWay(db, a, b)) {
    // Same message in both directions so neither side learns which of them
    // blocked the other.
    throw new AppError(403, ErrorCode.Blocked, 'You cannot interact with this user');
  }
}

async function areMutuals(db: Database, a: string, b: string): Promise<boolean> {
  const [row] = await db
    .select({ isMutual: follows.isMutual })
    .from(follows)
    .where(and(eq(follows.followerId, a), eq(follows.followeeId, b)))
    .limit(1);
  return row?.isMutual ?? false;
}

/**
 * Resolve one of the `everyone | contacts | nobody` privacy settings.
 * `contacts` means a mutual follow — a one-way follower is not a contact.
 */
export async function passesAudience(
  db: Database,
  audience: PrivacyAudience,
  ownerId: string,
  viewerId: string,
): Promise<boolean> {
  if (ownerId === viewerId) return true;
  switch (audience) {
    case 'everyone':
      return true;
    case 'nobody':
      return false;
    case 'contacts':
      return areMutuals(db, ownerId, viewerId);
  }
}

/**
 * `passesAudience` for a whole list, in one round trip.
 *
 * The member picker has to know which of twenty search results it may offer,
 * and asking per row would be twenty queries to render one screen. The only
 * audience needing a lookup is `contacts`, so this fetches the viewer's mutuals
 * among the candidates once and resolves the rest in memory.
 *
 * Returns the ids that pass. Anyone absent from the set failed, which is the
 * direction that matters: a picker that greys out too much is an annoyance, one
 * that offers someone it should not sends the user into a silent failure.
 */
export async function passesAudienceBatch(
  db: Database,
  viewerId: string,
  rows: Array<{ id: string; audience: PrivacyAudience }>,
): Promise<Set<string>> {
  const passing = new Set<string>();
  const needMutual: string[] = [];

  for (const row of rows) {
    if (row.id === viewerId || row.audience === 'everyone') passing.add(row.id);
    else if (row.audience === 'contacts') needMutual.push(row.id);
    // 'nobody' falls through: never passes.
  }

  if (needMutual.length > 0) {
    const mutuals = await db
      .select({ followeeId: follows.followeeId })
      .from(follows)
      .where(
        and(
          eq(follows.followerId, viewerId),
          eq(follows.isMutual, true),
          inArray(follows.followeeId, needMutual),
        ),
      );
    for (const m of mutuals) passing.add(m.followeeId);
  }

  return passing;
}

/**
 * Gate on starting a DM or a call. Checked before the conversation is created,
 * so a "nobody"-privacy user never receives an empty thread they cannot see.
 */
export async function assertCanInitiate(
  db: Database,
  targetUserId: string,
  actorId: string,
  kind: 'dm' | 'call' | 'group_add',
): Promise<void> {
  if (targetUserId === actorId) return;

  await assertNotBlocked(db, actorId, targetUserId);

  const [target] = await db
    .select({ privacy: users.privacy, suspendedUntil: users.suspendedUntil, deletedAt: users.deletedAt })
    .from(users)
    .where(eq(users.id, targetUserId))
    .limit(1);

  if (!target || target.deletedAt) throw notFound('User');

  const audience =
    kind === 'dm'
      ? target.privacy.whoCanDm
      : kind === 'call'
        ? target.privacy.whoCanCall
        : target.privacy.whoCanAddToGroups;

  if (!(await passesAudience(db, audience, targetUserId, actorId))) {
    throw new AppError(
      403,
      ErrorCode.PrivacyRestricted,
      kind === 'dm'
        ? 'This user only accepts messages from their contacts'
        : kind === 'call'
          ? 'This user only accepts calls from their contacts'
          : 'This user cannot be added to groups by you',
    );
  }
}

/** Writes are blocked for suspended accounts; reads are not. */
export function assertNotSuspended(user: { suspendedUntil: Date | null }): void {
  if (user.suspendedUntil && user.suspendedUntil > new Date()) {
    throw new AppError(403, ErrorCode.AccountSuspended, 'Your account is suspended');
  }
}

export const P = Permission;
