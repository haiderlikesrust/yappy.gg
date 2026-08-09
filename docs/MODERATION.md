# Moderation and staff operations

This is the operator's guide to running trust and safety on a yappy instance:
how staff are made, where reports go, and how to act on them. It assumes you can
run scripts on the server and have shell access to the database container.

## The two layers

Moderation on yappy happens at two levels, and they are independent.

**Group self-moderation.** Every group governs itself first. Owners, and the
roles they appoint, can pin and delete messages, kick, ban, mute, and manage
members, all bounded by the permission bitfield and by rank. This needs no
staff and no intervention from you; it is the same machinery any member uses,
scoped by their role.

**Instance staff.** On top of that sits a small team with instance-wide
authority: they see reports, and they can suspend accounts. This is what the
rest of this document is about.

## What "staff" is

Staff is authorisation, and it is deliberately kept separate from the staff
badge. The badge is a label anyone could in principle be given as an honour; the
`is_staff` column is what the moderation endpoints, yapper's staff commands, and
the portal's staff tab actually check. Nobody ever widens a permission by
editing a label.

Being staff is three things kept in step by one script:

- `is_staff` on the account (the authorisation the server checks),
- the `staff` badge (the mark everyone sees),
- a seat in the Yappy Staff space.

## Making someone staff

```bash
# In the packages/db directory, or via docker compose run.
node --env-file=../../.env scripts/grant-staff.mjs <username>
node --env-file=../../.env scripts/grant-staff.mjs <username> --revoke
```

This is a script and not an in-app action on purpose. The set of people who can
mint staff should be "whoever can run commands on the server", not "whoever is
already staff". Self-replicating admin is how one compromised account becomes
ten.

Bots cannot be staff. The script refuses.

## The Yappy Staff space

Staff coordinate inside the product rather than in some other company's chat
app, the same way Discord's own team lives on Discord. One space, found by
`system_key` rather than by title (so it cannot be broken by a rename), holds
the team:

```
Yappy Staff            (space)
  #general             general staff chat
  #reports             every report, as a card, with the actions on it
```

Create or repair it after granting the first staff member:

```bash
node --env-file=../../.env scripts/ensure-staff-space.mjs
```

The script is idempotent: run it again after adding staff and it converges. It
makes every `is_staff` account a member, and adds `@yapper`. yapper is a member
of this space and no other; its own privacy settings refuse every other group
add, and this one seat is made by a direct database insert rather than through
the API, because the API path is for users and users must not be able to do
this.

> **After running it, restart the API.** The API caches the staff channel ids at
> boot, so a freshly created `#reports` will not receive cards until the next
> restart: `docker compose -f docker-compose.prod.yml restart api`.

## How a report reaches staff

A report can come from two places, and both end up the same way.

- **In-app report button**, which calls `POST /moderation/reports`.
- **`@yapper`'s `/report` flow**, a guided conversation: who, then a category
  from a row of buttons, then what happened in their own words, then proof,
  then a confirm button.

The category is asked as buttons rather than typed, and that is the load-bearing
detail: `reason` is the field triage sorts on. Priority is derived from it, the
classifier hook switches on it, and the card in `#reports` titles itself with
it. Both surfaces write the same eight values and call the same
`reportPriority()`, so a category means the same urgency however the report was
filed. The person's own account of what happened goes to `detail`, where prose
belongs.

Either way, the report is filed with a **frozen evidence snapshot**. For a
reported message, that snapshot includes a copy of the message and the twenty
messages of context around it, captured at report time. This matters because
deleting the evidence is the first thing a bad actor does, and a report whose
subject has already been deleted is otherwise unactionable.

The report is then mirrored into `#reports` as a card posted by yapper, carrying
**Resolve**, **Dismiss**, and **Suspend 7d** buttons. Reports for CSAM or
credible self-harm jump the queue and are marked priority, and yapper posts a
separate high-priority message alongside the card — those two categories must
not wait for someone to happen to glance at the channel.

## What yapper says without being asked

The queue is also watched rather than only served. On a schedule, yapper posts
to `#reports`:

| When | What |
|---|---|
| Daily, 08:00 UTC | The queue: open count, how many are priority, the oldest, and how many closed yesterday |
| Hourly | Anything open longer than a day — once per day, not once per hour, because a channel that nags gets muted |
| Hourly | Three or more *distinct* reporters against one account in 24 hours, which reads differently from three reports spread over a year |

And to the people involved:

| When | Who hears | What |
|---|---|---|
| A report is closed | The reporter | That it was reviewed and closed — never the outcome, for the same reason the filing response is vague |
| A suspension is applied | The suspended account | Why, and until when. It waits for them: a suspension ends every session, so the notice is readable when the suspension is over |

Every one of these is deduplicated on a stable key, so a re-run of the detection
resolves to the same message rather than a second copy.

## Acting on a report

Two surfaces, one outcome. A report is one report: whichever surface acts first
wins, and the other shows "already handled" rather than double-acting.

**From `#reports` in the app.** Press a button on the card. The buttons are
`staffOnly`, enforced server-side against `is_staff` on the presser, so being
able to see the channel is not what authorises the action. The card rewrites
itself into the outcome, naming who acted, and its buttons retire.

**From the portal.** Open `https://yappy.gg/portal`, sign in as staff, and use
the Moderation tab. It shows the open queue with the full frozen evidence
expandable inline, and gives each report a note field, Resolve, Dismiss, and a
Suspend control with an adjustable day count.

**From a DM with yapper.** Staff have two extra commands, invisible to everyone
else and refused with an identical "unknown command" reply if a non-staff
account probes them:

- `/reports` shows the open queue.
- `/lookup @someone` shows a user as staff see them: account id, email, join
  date, reports filed against them, and suspension state.

Every action, from any surface, writes a row to the moderation audit log naming
the staff member who took it. An audit log where every row says "the system" is
not an audit log.

## What a suspension does

Suspending an account is not cosmetic. It:

- sets `suspended_until`, so the account is blocked from every write while the
  suspension lasts;
- bumps `token_epoch`, which immediately invalidates every access token the
  account holds, so open sessions and live sockets die at once;
- causes login to be refused, after the password check, with the suspension end
  date in the message.

The password check comes first on purpose: a suspension is information, and it
is only owed to someone who has proven they own the account. The write block in
the auth layer is a backstop, so that any future code path that sets
`suspended_until` and forgets the other two steps still cannot let a suspended
account post.

Suspensions are time-boxed. When `suspended_until` passes, the account writes
again on its own, with no further action.

## Reporter privacy

Reporters are never told what happened to the account they reported. The report
endpoint returns a flat "our team will review this", and the reporter's own
`/moderation/reports/mine` collapses internal states to just "reviewing" or
"resolved". Telling a reporter the outcome tells a harasser whether their target
reported them.

## Quick reference

| Task | How |
|---|---|
| Make someone staff | `grant-staff.mjs <username>` |
| Remove staff | `grant-staff.mjs <username> --revoke` |
| Create/repair the staff space | `ensure-staff-space.mjs`, then restart the API |
| See the open queue | `#reports` channel, portal Moderation tab, or `/reports` to yapper |
| Look someone up | `/lookup @someone` to yapper, or the portal |
| Act on a report | Card buttons in `#reports`, or the portal |
| Endpoints | `GET/POST /portal/staff/reports*`, `POST /moderation/reports` |
