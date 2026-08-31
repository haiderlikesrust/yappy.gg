# Permissions

yappy uses a 64-bit permission bitfield, the same one for people and for bots.
This page is the reference: the bits, how they combine, and the one rule that
governs every check.

## The rule

> Authorisation is always checked against the person who invoked the action,
> never against the bot.

A moderation bot may hold every permission in a group. That must not let an
ordinary member borrow those powers by pressing one of its buttons. When a
button carries `requiredPermissions`, the server checks the presser's own
effective permissions in that conversation and refuses with 403 if they fall
short, before your bot is ever told the press happened.

## On the wire

Bitfields travel as **decimal strings**, never as numbers:

```json
{ "userId": "usr_...", "permissions": "4398046511111", "isStaff": false }
```

The field runs to bit 62, and a JavaScript number loses precision past 2^53, so
a numeric field would silently corrupt the high bits. Parse as a big integer and
test with a bitwise AND — or let the SDK do it:

```js
import { perms } from '@yappydotgg/bot-sdk';

if (perms.has(response.permissions, 'KICK_MEMBERS')) {
  // allowed
}

// The decimal string to put on a button or a command:
perms.bits('KICK_MEMBERS', 'BAN_MEMBERS')
```

```js
const held = BigInt(response.permissions);
const KICK_MEMBERS = 1n << 32n;

if ((held & KICK_MEMBERS) === KICK_MEMBERS) {
  // allowed
}
```

## The bits

| Bit | Name | What it allows |
|---|---|---|
| 0 | VIEW_CONVERSATION | See that the conversation exists |
| 1 | READ_HISTORY | Read messages sent before joining |
| 2 | SEND_MESSAGES | Post |
| 3 | SEND_MEDIA | Attach images, video, files |
| 4 | SEND_VOICE_NOTES | Post voice notes |
| 5 | SEND_STICKERS | Post stickers |
| 6 | SEND_GIFS | Post GIFs |
| 7 | SEND_POLLS | Create polls |
| 8 | ADD_REACTIONS | React |
| 9 | MENTION_ALL | Mention everyone at once |
| 10 | EMBED_LINKS | Have links unfurl into previews |
| 11 | EDIT_OWN_MESSAGES | Edit your own |
| 12 | DELETE_OWN_MESSAGES | Delete your own |
| 13 | DELETE_ANY_MESSAGE | Delete anyone's |
| 14 | PIN_MESSAGES | Pin and unpin |
| 20 | START_CALL | Start a call |
| 21 | JOIN_CALL | Join an ongoing call |
| 22 | END_CALL_FOR_ALL | End a call for everyone |
| 23 | SCREEN_SHARE | Share a screen |
| 30 | INVITE_MEMBERS | Add people and bots |
| 31 | MANAGE_INVITES | Create and revoke invite links |
| 32 | KICK_MEMBERS | Remove a member |
| 33 | BAN_MEMBERS | Remove and bar from returning |
| 34 | MUTE_MEMBERS | Silence a member |
| 35 | MANAGE_ROLES | Create roles and assign them |
| 36 | MANAGE_CONVERSATION | Rename, re-picture, change settings |
| 37 | MANAGE_STICKERS | Manage custom emoji and stickers |
| 62 | ADMINISTRATOR | Everything |

The gaps in the numbering are deliberate. Bits are grouped by area with room to
grow, so a new media permission does not have to be allocated next to the
moderation ones and make the constant list unreadable.

## How a member's permissions are computed

Three layers, combined in order:

1. The conversation's base permissions, which is what an ordinary member gets.
2. Every role the member holds, ORed together.
3. The member's rank: owner, admin, moderator, or member.

`ADMINISTRATOR` implies every other bit. Nothing implies `ADMINISTRATOR`.

Rank is not a permission and does not live in the bitfield. It answers a
different question: not "may this action happen" but "may this person be acted
upon". A member can only act on members below them, so holding `KICK_MEMBERS`
does not let you kick the owner, and two admins cannot kick each other.

Rank always comes from the **space's** membership row. A channel keeps a copy
of it for its own bookkeeping, and that copy is written once and never
refreshed — so it drifts the moment anybody is promoted or ownership moves.
Nothing should read it, and nothing does.

## Channel visibility

A channel is visible to you when your effective permissions there include
`VIEW_CONVERSATION` — or `ADMINISTRATOR`, which short-circuits everything.

Three things can make a channel invisible to ordinary members:

- `basePermissions = 0` on the channel (what `isPrivate` sets),
- a role overwrite that denies `VIEW_CONVERSATION`,
- a per-member `deny` on that channel.

**Lowering the base does not hide a channel from staff.** The ladder is ORed
on top of the base, and `MODERATOR` is built on the member baseline, which
carries `VIEW_CONVERSATION`. So a private channel is private *from members*:
moderators, admins and the owner still see it. That is what makes it usable
for support tickets, where somebody has to be able to answer. To hide a
channel from moderators as well you need a role overwrite that denies them —
and nothing can hide one from an administrator, by design.

This is not only a REST rule. The same predicate governs realtime delivery,
push notifications and mention fan-out, so a channel you cannot see does not
reach you by any route. It lives in SQL —
`conversation_viewers(conversation_id)` and
`can_view_conversation(conversation_id, user_id)` in
`packages/db/sql/0003_functions.sql` — because the gateway and the push worker
need the same answer the API gives and cannot call into its TypeScript.

That SQL is a second implementation of `effectivePermissions()`, which is a
thing to be nervous about, so `pnpm --filter @yappy/db visibility-parity`
asks both the same question about the same inputs and fails on any
disagreement.

## Applications

A bot is a user row with `is_bot` set. It has no scopes and no separate
endpoint surface: authorisation is conversation membership and the same
bitfield everything else uses.

What a bot may do in a space is granted at install time by a human who holds
those bits themselves:

```
PUT    /v1/conversations/:id/apps/:applicationId   { "permissions": "<decimal>" }
DELETE /v1/conversations/:id/apps/:applicationId
GET    /v1/conversations/:id/apps
```

The grant lands on the bot's own `conversation_members.allow`, so every
existing permission check sees it without knowing applications exist. The
listing is readable by any member — what a program may do in a room is a
question everyone in that room can ask.

A bot stays at ladder rank `member` and is never promoted. Instead it may act
on **ordinary members** without outranking them (`assertMayActOn` in
`apps/api/src/lib/access.ts`), which is what lets a support bot hand out a role
without also being able to kick and mute. Three things keep that narrow:

- it can never touch staff — `member` and `restricted` only;
- it cannot exceed itself, because every caller still checks the delta against
  the bot's own permissions;
- it cannot exceed its installer, because the install refuses bits the
  installer does not hold.

A grant may not carry the bits an ordinary member already has in an open
channel. It writes to the bot's **space** membership row, and a per-member
allow at the space applies in every channel under it — which is right for
`MANAGE_CONVERSATION` and a skeleton key for `VIEW_CONVERSATION`. A bot that is
simply a member already sees and posts in every ordinary channel, so granting
those adds nothing and its only effect would be to reach past every
restriction in the space. To let a bot into a locked channel, admit it to that
channel.

**No application is ever an administrator.** Refused at the install, at role
assignment, and at a direct `allow` write — for everyone including the owner,
the one place in the model where the owner does not get the last word. A bot's
rights live in a credential in a deployment environment, and a leaked token
must not be the space.

## Checking someone else's permissions

Before acting on a typed command such as `/ban @someone`, ask:

```
GET /v1/conversations/:id/members/:userId/permissions
```

```json
{ "userId": "usr_...", "permissions": "4398046511111", "isStaff": false }
```

For a button press you do not need this call. The `interaction.pressed` webhook
already carries the invoker's `permissions` and `isStaff`.

## Gating your own commands

Declare a command with the bits it needs and the composer stops offering it to
members who lack them:

```json
{
  "commands": [
    { "name": "ban", "description": "Ban a member", "requiredPermissions": "4294967296" }
  ]
}
```

`4294967296` is `1 << 32`, `KICK_MEMBERS` — `perms.bits('KICK_MEMBERS')` if
you would rather not keep the shift in your head.

This is filtering, not enforcement. It keeps `/ban` out of the autocomplete of
someone who could not use it, which is a courtesy rather than a boundary. The
boundary is your own check on the way in, and the server's check on a button
press. Use all three.
