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
