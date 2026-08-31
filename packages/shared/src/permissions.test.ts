/**
 * The permission composition, tested against intent.
 *
 * `effectivePermissions` decides who can read a private channel, who can hand
 * out a role, and who can take a group away from its owner. Until now the only
 * thing checking it was `visibility-parity`, which proves the SQL copy agrees
 * with this function — a valuable thing, and a completely different question.
 * Two implementations can agree perfectly and both be wrong.
 *
 * So these are about *intent*, and they are deliberately written as the
 * sentences the model is supposed to mean rather than as a table of bitfields.
 * They need no database, no server and no network, which is the point: the
 * eight check scripts in this repo all need a live stack, so nothing was
 * verifying this on the way to a commit.
 *
 * Node's own runner, so this adds no dependency:
 *
 *   pnpm --filter @yappy/shared test
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ALL_PERMISSIONS,
  DEFAULT_CONVERSATION_PERMISSIONS,
  Permission,
  ROLE_PERMISSIONS,
  effectivePermissions,
  has,
  hasAny,
  outranks,
  parsePermissions,
  permissionNames,
  serializePermissions,
} from './permissions.js';
import type { MemberRole } from './constants.js';

/** A channel member with nothing special about them, unless said otherwise. */
const member = (over: Partial<Parameters<typeof effectivePermissions>[0]> = {}) =>
  effectivePermissions({ conversationType: 'channel', role: 'member', ...over });

const can = (perms: bigint, bit: bigint) => has(perms, bit);

describe('the ladder', () => {
  it('gives a plain member exactly the base and nothing more', () => {
    // The whole reason a lowered base means anything.
    assert.equal(ROLE_PERMISSIONS.member, 0n);
    assert.equal(member({ basePermissions: 0n }), 0n);
  });

  it('makes an owner absolute regardless of the base', () => {
    assert.equal(member({ role: 'owner', basePermissions: 0n }), ALL_PERMISSIONS);
  });

  it('carries staff past a zeroed base', () => {
    // The thing that makes a "private" channel answerable: staff still see it.
    for (const role of ['moderator', 'admin'] as MemberRole[]) {
      assert.ok(
        can(member({ role, basePermissions: 0n }), Permission.VIEW_CONVERSATION),
        `${role} should still see a channel floored to nothing`,
      );
    }
    assert.ok(!can(member({ basePermissions: 0n }), Permission.VIEW_CONVERSATION));
  });

  it('ranks owner over admin over moderator over member over restricted', () => {
    const ladder: MemberRole[] = ['owner', 'admin', 'moderator', 'member', 'restricted'];
    for (let i = 0; i < ladder.length - 1; i += 1) {
      assert.ok(outranks(ladder[i]!, ladder[i + 1]!), `${ladder[i]} should outrank ${ladder[i + 1]}`);
      assert.ok(!outranks(ladder[i + 1]!, ladder[i]!), 'and not the other way round');
    }
  });

  it('never lets equal ranks act on each other', () => {
    // Two admins demoting each other is the failure this prevents.
    for (const role of ['owner', 'admin', 'moderator', 'member', 'restricted'] as MemberRole[]) {
      assert.ok(!outranks(role, role));
    }
  });
});

describe('ADMINISTRATOR', () => {
  it('implies everything', () => {
    const perms = member({ basePermissions: Permission.ADMINISTRATOR });
    assert.equal(perms, ALL_PERMISSIONS);
  });

  it('survives a channel overwrite that denies it', () => {
    // The ordering that stops a channel overwrite locking an owner out of
    // their own space: the bypass runs before the overwrites.
    const perms = member({
      basePermissions: Permission.ADMINISTRATOR,
      roleDeny: Permission.VIEW_CONVERSATION,
    });
    assert.ok(can(perms, Permission.VIEW_CONVERSATION), 'has() short-circuits on ADMINISTRATOR');
  });

  it('is not implied by holding every other bit', () => {
    const everythingElse = ALL_PERMISSIONS & ~Permission.ADMINISTRATOR;
    assert.ok(!can(everythingElse, Permission.ADMINISTRATOR));
  });
});

describe('overwrites compose narrowest-last', () => {
  it('lets one role grant what another withholds', () => {
    const perms = member({
      basePermissions: 0n,
      roleDeny: Permission.SEND_MESSAGES,
      roleAllow: Permission.SEND_MESSAGES,
    });
    assert.ok(can(perms, Permission.SEND_MESSAGES), 'allow applies after deny within the role tier');
  });

  it('lets a per-member allow beat a role deny', () => {
    const perms = member({
      basePermissions: 0n,
      roleDeny: Permission.VIEW_CONVERSATION,
      allow: Permission.VIEW_CONVERSATION,
    });
    assert.ok(can(perms, Permission.VIEW_CONVERSATION));
  });

  it('lets a per-member deny beat everything below it', () => {
    const perms = member({
      basePermissions: Permission.VIEW_CONVERSATION,
      roleAllow: Permission.VIEW_CONVERSATION,
      allow: Permission.VIEW_CONVERSATION,
      deny: Permission.VIEW_CONVERSATION,
    });
    assert.ok(!can(perms, Permission.VIEW_CONVERSATION), 'the narrowest statement wins');
  });
});

describe('restricted', () => {
  it('is read-only', () => {
    const perms = member({ role: 'restricted' });
    assert.ok(can(perms, Permission.VIEW_CONVERSATION));
    assert.ok(can(perms, Permission.READ_HISTORY));
    assert.ok(!can(perms, Permission.SEND_MESSAGES));
  });

  it('ignores the base and the channel overwrites', () => {
    /*
     * Documented rather than endorsed. permissions.ts:214 returns
     * RESTRICTED | allow without consulting the base or the role tier, so a
     * restricted member sees a channel floored to nothing. The SQL mirrors
     * this deliberately — a fan-out that disagrees with REST is worse than an
     * odd rule applied consistently — and this test exists so that changing
     * it is a decision somebody makes on purpose rather than a surprise.
     */
    const perms = member({ role: 'restricted', basePermissions: 0n, roleDeny: ALL_PERMISSIONS });
    assert.ok(can(perms, Permission.VIEW_CONVERSATION));
  });

  it('can still be shut out by a per-member deny', () => {
    const perms = member({ role: 'restricted', deny: Permission.VIEW_CONVERSATION });
    assert.ok(!can(perms, Permission.VIEW_CONVERSATION));
  });

  it('can be let back in one channel by a per-member allow', () => {
    const perms = member({ role: 'restricted', allow: Permission.SEND_MESSAGES });
    assert.ok(can(perms, Permission.SEND_MESSAGES));
  });
});

describe('mute', () => {
  const future = new Date(Date.now() + 60_000);
  const past = new Date(Date.now() - 60_000);

  it('takes speech away and leaves reading alone', () => {
    const perms = member({ mutedUntil: future });
    assert.ok(!can(perms, Permission.SEND_MESSAGES));
    assert.ok(!can(perms, Permission.ADD_REACTIONS));
    assert.ok(can(perms, Permission.VIEW_CONVERSATION), 'a mute is not a ban');
    assert.ok(can(perms, Permission.READ_HISTORY));
  });

  it('never touches VIEW_CONVERSATION — which is why the SQL omits it', () => {
    const muted = member({ mutedUntil: future });
    const not = member({ mutedUntil: null });
    assert.equal(
      has(muted, Permission.VIEW_CONVERSATION),
      has(not, Permission.VIEW_CONVERSATION),
    );
  });

  it('expires', () => {
    assert.ok(can(member({ mutedUntil: past }), Permission.SEND_MESSAGES));
  });

  it('cannot silence an administrator', () => {
    const perms = member({ basePermissions: Permission.ADMINISTRATOR, mutedUntil: future });
    assert.ok(can(perms, Permission.SEND_MESSAGES));
  });
});

describe('conversation defaults', () => {
  it('gives a space no SEND_MESSAGES — it is a container, not a room', () => {
    // The fact that made a channel-level subset check silently owner-only.
    assert.ok(!can(DEFAULT_CONVERSATION_PERMISSIONS.space, Permission.SEND_MESSAGES));
    assert.ok(can(DEFAULT_CONVERSATION_PERMISSIONS.channel, Permission.SEND_MESSAGES));
  });

  it('gives both sides of a DM the same rights', () => {
    const dm = (role: MemberRole) => effectivePermissions({ conversationType: 'dm', role });
    assert.ok(can(dm('member'), Permission.SEND_MESSAGES));
    assert.ok(can(dm('member'), Permission.PIN_MESSAGES), 'no moderation surface in a DM');
  });

  it('never grants ADMINISTRATOR by default anywhere', () => {
    for (const [type, base] of Object.entries(DEFAULT_CONVERSATION_PERMISSIONS)) {
      assert.ok((base & Permission.ADMINISTRATOR) === 0n, `${type} must not default to administrator`);
    }
  });
});

describe('the bitfield on the wire', () => {
  it('round-trips through a decimal string past 2^53', () => {
    const big = Permission.ADMINISTRATOR | Permission.VIEW_CONVERSATION;
    assert.ok(big > BigInt(Number.MAX_SAFE_INTEGER), 'the case a JS number would lose');
    assert.equal(parsePermissions(serializePermissions(big)), big);
  });

  it('reads absent values as nothing rather than throwing', () => {
    for (const empty of [null, undefined, '']) {
      assert.equal(parsePermissions(empty), 0n);
    }
  });

  it('names the bits it holds and no others', () => {
    const names = permissionNames(Permission.KICK_MEMBERS | Permission.BAN_MEMBERS);
    assert.deepEqual(new Set(names), new Set(['KICK_MEMBERS', 'BAN_MEMBERS']));
  });

  it('fits inside a signed 64-bit integer, because Postgres stores it as one', () => {
    assert.ok(ALL_PERMISSIONS < 2n ** 63n - 1n);
  });
});

describe('has and hasAny', () => {
  it('requires every bit for has, any bit for hasAny', () => {
    const held = Permission.KICK_MEMBERS;
    const wanted = Permission.KICK_MEMBERS | Permission.BAN_MEMBERS;
    assert.ok(!has(held, wanted));
    assert.ok(hasAny(held, wanted));
  });

  it('answers true for an empty requirement', () => {
    assert.ok(has(0n, 0n), 'asking for nothing is always satisfied');
  });
});
