/**
 * The permission bitfield, copied rather than imported — same reasoning as
 * `types.ts`. These values are the contract. A rename in the server's source
 * must not break a bot that imported `KICK_MEMBERS` last year.
 *
 * On the wire the field is a decimal string: JavaScript numbers lose precision
 * past 2^53 and the field runs to bit 62. Everything here parses and emits
 * strings, so a bot never has to remember that.
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

/** A name, a list of names, or a decimal string already on the wire. */
export type PermissionInput = PermissionName | readonly PermissionName[] | string;

const NAMES = Object.keys(Permission) as PermissionName[];

function isName(value: string): value is PermissionName {
  return Object.prototype.hasOwnProperty.call(Permission, value);
}

export function parse(bitfield: string | bigint | number | null | undefined): bigint {
  if (bitfield === null || bitfield === undefined || bitfield === '') return 0n;
  return BigInt(bitfield);
}

/** The decimal string to put in `requiredPermissions` or a command declaration. */
export function bits(...names: PermissionName[]): string {
  let acc = 0n;
  for (const name of names) {
    if (!isName(name)) throw new Error(`Unknown permission "${name}"`);
    acc |= Permission[name];
  }
  return acc.toString(10);
}

/**
 * Accept whatever a bot author is holding — a name, a list of names, or a
 * decimal string — and return the wire form. `button()` uses this so a Ban
 * button can say `requiredPermissions: 'BAN_MEMBERS'` instead of
 * `'8589934592'`.
 */
export function resolve(input: PermissionInput): string {
  if (Array.isArray(input)) return bits(...input);
  if (typeof input === 'string' && /^\d+$/.test(input)) return input;
  if (typeof input === 'string' && isName(input)) return bits(input);
  throw new Error(`Unknown permission "${String(input)}"`);
}

/**
 * Does this bitfield hold every named permission?
 *
 * `ADMINISTRATOR` counts as holding everything, matching the server. The
 * bitfield is the *presser's* (or the command invoker's), never the bot's.
 */
export function has(bitfield: string | bigint, ...required: PermissionName[]): boolean {
  const held = parse(bitfield);
  if (held & Permission.ADMINISTRATOR) return true;
  const need = parse(bits(...required));
  return (held & need) === need;
}

/** True if any of the named bits are set. `ADMINISTRATOR` still wins. */
export function hasAny(bitfield: string | bigint, ...required: PermissionName[]): boolean {
  const held = parse(bitfield);
  if (held & Permission.ADMINISTRATOR) return true;
  const need = parse(bits(...required));
  return (held & need) !== 0n;
}

export function names(bitfield: string | bigint): PermissionName[] {
  const held = parse(bitfield);
  return NAMES.filter((name) => (held & Permission[name]) !== 0n);
}

/**
 * The helpers, grouped. Prefer `perms.has(invoker.permissions, 'KICK_MEMBERS')`
 * at the point of a press over reaching for `BigInt` yourself.
 */
export const perms = { Permission, parse, bits, resolve, has, hasAny, names };
