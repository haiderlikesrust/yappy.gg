import type { ConversationType, MemberRole } from './constants.js';

/**
 * Permissions are a 64-bit field, Discord-style.
 *
 * Why a bitfield instead of a `roles` lookup on every request: authorisation is
 * checked on literally every message send, edit, reaction and pin. Collapsing a
 * member's effective rights into one integer we can cache on the member row
 * turns that check into a bitwise AND instead of a join.
 *
 * Serialised as a decimal *string* in JSON — JS numbers lose precision past
 * 2^53 and we have room to grow past bit 53.
 */
export const Permission = {
  VIEW_CONVERSATION: 1n << 0n,
  READ_HISTORY: 1n << 1n,
  SEND_MESSAGES: 1n << 2n,
  SEND_MEDIA: 1n << 3n,
  SEND_VOICE_NOTES: 1n << 4n,
  SEND_STICKERS: 1n << 5n,
  SEND_GIFS: 1n << 6n,
  SEND_POLLS: 1n << 7n,
  ADD_REACTIONS: 1n << 8n,
  MENTION_ALL: 1n << 9n,
  EMBED_LINKS: 1n << 10n,

  EDIT_OWN_MESSAGES: 1n << 11n,
  DELETE_OWN_MESSAGES: 1n << 12n,
  DELETE_ANY_MESSAGE: 1n << 13n,
  PIN_MESSAGES: 1n << 14n,

  START_CALL: 1n << 20n,
  JOIN_CALL: 1n << 21n,
  END_CALL_FOR_ALL: 1n << 22n,
  SCREEN_SHARE: 1n << 23n,

  INVITE_MEMBERS: 1n << 30n,
  MANAGE_INVITES: 1n << 31n,
  KICK_MEMBERS: 1n << 32n,
  BAN_MEMBERS: 1n << 33n,
  MUTE_MEMBERS: 1n << 34n,
  MANAGE_ROLES: 1n << 35n,
  MANAGE_CONVERSATION: 1n << 36n,
  MANAGE_STICKERS: 1n << 37n,

  ADMINISTRATOR: 1n << 62n,
} as const;

export type PermissionName = keyof typeof Permission;

export const ALL_PERMISSIONS = Object.values(Permission).reduce((a, b) => a | b, 0n);

const SEND_BUNDLE =
  Permission.SEND_MESSAGES |
  Permission.SEND_MEDIA |
  Permission.SEND_VOICE_NOTES |
  Permission.SEND_STICKERS |
  Permission.SEND_GIFS |
  Permission.SEND_POLLS |
  Permission.ADD_REACTIONS |
  Permission.EMBED_LINKS;

const OWN_MESSAGE_BUNDLE = Permission.EDIT_OWN_MESSAGES | Permission.DELETE_OWN_MESSAGES;

const BASE_MEMBER =
  Permission.VIEW_CONVERSATION |
  Permission.READ_HISTORY |
  SEND_BUNDLE |
  OWN_MESSAGE_BUNDLE |
  Permission.START_CALL |
  Permission.JOIN_CALL |
  Permission.SCREEN_SHARE |
  Permission.INVITE_MEMBERS;

const MODERATOR =
  BASE_MEMBER |
  Permission.DELETE_ANY_MESSAGE |
  Permission.PIN_MESSAGES |
  Permission.MUTE_MEMBERS |
  Permission.KICK_MEMBERS |
  Permission.MENTION_ALL |
  Permission.END_CALL_FOR_ALL;

const ADMIN =
  MODERATOR |
  Permission.BAN_MEMBERS |
  Permission.MANAGE_CONVERSATION |
  Permission.MANAGE_INVITES |
  Permission.MANAGE_STICKERS |
  Permission.MANAGE_ROLES;

/** A restricted member is read-only: still in the group, cannot speak. */
const RESTRICTED = Permission.VIEW_CONVERSATION | Permission.READ_HISTORY | Permission.JOIN_CALL;

/**
 * What each rung of the ladder adds *on top of* the conversation base.
 *
 * `member` is deliberately zero: an ordinary member gets exactly the base and
 * nothing more, which is what makes a lowered base (an announcement channel, a
 * read-only archive) mean anything at all. `owner` and `restricted` are handled
 * as absolutes in `effectivePermissions` and are listed here only so the record
 * stays total.
 */
export const ROLE_PERMISSIONS: Record<MemberRole, bigint> = {
  owner: ALL_PERMISSIONS,
  admin: ADMIN,
  moderator: MODERATOR,
  member: 0n,
  restricted: RESTRICTED,
};

/** The default member baseline, for callers building a conversation's base. */
export const BASE_MEMBER_PERMISSIONS = BASE_MEMBER;

/**
 * Defaults applied to *every* member of a conversation, before role and
 * per-member overrides. A group owner lowering this is how "only admins can
 * send messages" announcement groups work.
 */
export const DEFAULT_CONVERSATION_PERMISSIONS: Record<ConversationType, bigint> = {
  // In a DM both sides are peers; there is no moderation surface.
  dm:
    Permission.VIEW_CONVERSATION |
    Permission.READ_HISTORY |
    SEND_BUNDLE |
    OWN_MESSAGE_BUNDLE |
    Permission.PIN_MESSAGES |
    Permission.START_CALL |
    Permission.JOIN_CALL |
    Permission.SCREEN_SHARE,
  group: BASE_MEMBER,
  /**
   * A channel inside a space behaves like a group — the broadcast-only case is
   * expressed by lowering `basePermissions` on that one channel, which is how
   * an #announcements channel is built.
   */
  channel: BASE_MEMBER,
  /**
   * A space itself is never posted in, so its base grants only the rights that
   * make sense on a container. Its channels get their own base.
   */
  space:
    Permission.VIEW_CONVERSATION |
    Permission.READ_HISTORY |
    Permission.JOIN_CALL |
    Permission.INVITE_MEMBERS,
};

export const ROLE_RANK: Record<MemberRole, number> = {
  owner: 4,
  admin: 3,
  moderator: 2,
  member: 1,
  restricted: 0,
};

export interface EffectivePermissionInput {
  conversationType: ConversationType;
  /** Conversation-wide base, overriding the type default. */
  basePermissions?: bigint | null;
  role: MemberRole;
  /**
   * Union of the permissions on every named role this member holds.
   *
   * Additive only — a named role can never take a permission away. Removing
   * rights is what `deny` is for, and keeping subtraction in exactly one place
   * means "why can this person still post?" has one answer instead of a search
   * through every role they hold.
   */
  rolePermissions?: bigint | null;
  /**
   * Channel overwrites for the roles this member holds, unioned.
   *
   * Applied after the base and the roles, before the per-member pair.
   * Denies first across every role, then allows — so a member in two roles,
   * one denied here and one allowed, is allowed. The alternative (allow
   * first, then deny) would mean a single restrictive role could veto every
   * grant a person has, which is not what "give Premium access to this
   * channel" is supposed to mean.
   */
  roleAllow?: bigint | null;
  roleDeny?: bigint | null;
  /** Per-member grants, e.g. one trusted user allowed to pin. */
  allow?: bigint | null;
  /** Per-member denies, e.g. one user muted without demoting them. */
  deny?: bigint | null;
  /** Set while a timed mute is in effect. */
  mutedUntil?: Date | null;
  now?: Date;
}

/**
 * Resolution order: ladder role over conversation base → named roles → member
 * allow → member deny → active mute. Deny beats allow, and ADMINISTRATOR
 * short-circuits everything except a mute (so an admin who mutes themselves
 * stays muted, which is what users expect from a "mute me" button).
 *
 * The ladder is resolved *per rank*, not unioned with the base, and that
 * distinction carries real weight:
 *
 *   `member` **is** the base. Unioning `ROLE_PERMISSIONS.member` on top would
 *   mean a conversation could never grant an ordinary member less than the
 *   default — so an announcement channel (base without SEND_MESSAGES) would
 *   still let everyone post, and `restricted` would be a no-op, because both
 *   work by lowering the floor.
 *
 *   `restricted` ignores the base and the member's named roles entirely. It is
 *   a state, not a rank: the point is that nothing else in the system can
 *   quietly hand back the ability to speak.
 */
export function effectivePermissions(input: EffectivePermissionInput): bigint {
  const base = input.basePermissions ?? DEFAULT_CONVERSATION_PERMISSIONS[input.conversationType];

  if (input.role === 'restricted') {
    // Read-only, full stop. Only an explicit per-member `allow` reaches it,
    // which is how one person is let back in without a promotion.
    let restricted = RESTRICTED | (input.allow ?? 0n);
    restricted &= ~(input.deny ?? 0n);
    return restricted;
  }

  let perms =
    input.role === 'owner'
      ? ALL_PERMISSIONS
      : base | ROLE_PERMISSIONS[input.role] | (input.rolePermissions ?? 0n);

  // A moderator or admin keeps their extras in an announcement channel, but a
  // plain member does not gain anything the base did not give them: for
  // `member`, ROLE_PERMISSIONS is 0 and this reduces to the base exactly.
  if (perms & Permission.ADMINISTRATOR) perms = ALL_PERMISSIONS;

  /*
   * Channel overwrites, then the per-member pair.
   *
   * Order is the whole design. Deny-then-allow within the role tier lets
   * one role grant what another withholds; the member tier applies last
   * because a statement about one person is more deliberate than one about
   * a group they happen to be in.
   *
   * An administrator is exempt above and stays exempt: a channel overwrite
   * must not be a way to lock the owner out of their own space.
   */
  perms &= ~(input.roleDeny ?? 0n);
  perms |= input.roleAllow ?? 0n;

  perms |= input.allow ?? 0n;
  perms &= ~(input.deny ?? 0n);

  const now = input.now ?? new Date();
  if (input.mutedUntil && input.mutedUntil > now) {
    perms &= ~(SEND_BUNDLE | Permission.MENTION_ALL | Permission.START_CALL);
  }

  return perms;
}

export function has(perms: bigint, required: bigint): boolean {
  return (perms & Permission.ADMINISTRATOR) !== 0n || (perms & required) === required;
}

export function hasAny(perms: bigint, required: bigint): boolean {
  return (perms & Permission.ADMINISTRATOR) !== 0n || (perms & required) !== 0n;
}

export function permissionNames(perms: bigint): PermissionName[] {
  return (Object.keys(Permission) as PermissionName[]).filter((k) => (perms & Permission[k]) !== 0n);
}

export const serializePermissions = (p: bigint): string => p.toString(10);
export const parsePermissions = (p: string | number | bigint | null | undefined): bigint =>
  p === null || p === undefined || p === '' ? 0n : BigInt(p);

/**
 * Can `actor` act on `target`? Strictly-higher rank required, and never on
 * yourself.
 *
 * Reads the fixed ladder only. Named roles deliberately do not participate:
 * they grant capabilities, not authority over people, so holding a custom role
 * with KICK_MEMBERS still does not let you kick an admin. See
 * `conversation_roles` for why there is only one hierarchy.
 */
export function outranks(actor: MemberRole, target: MemberRole): boolean {
  return ROLE_RANK[actor] > ROLE_RANK[target];
}
