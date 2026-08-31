# iOS parity backlog

> **15 Aug 2026:** everything marked [x] below was implemented in Swift
> in one parity push (six parallel work streams). None of it has been
> compiled - the next Mac build must verify before any item is considered
> truly closed. Per-stream caveats live in the commit message.

What Android has that iOS does not, as of **15 Aug 2026**. The iOS build
(1.x, calling disabled) has been frozen since it entered App Review; every
Android release since has widened this list. Work through it top-down once
iOS development reopens — items are grouped by how much of the work is
already done server-side.

**Rule that made this list safe to grow:** every server change since the
freeze is wire-additive. iOS decodes with explicit CodingKeys, so unknown
fields are ignored — nothing here is blocked on a server migration, and
nothing shipped has broken the build in review.

---

## Server already done — iOS is client-work only

These have live endpoints/fields today. iOS needs UI + decoding only.

- [x] **@yapper AI in groups** — WORKS on the in-review build, tested on a
  device 15 Aug 2026: added through the existing iOS bot picker (yapper is
  in `/apps/directory` now), mentioned, answered. Remaining is cosmetic
  only: the dedicated "yapper ✨" settings row Android has, and the bottom
  typing bubble (iOS shows header typing). (`apps/api/src/lib/yapperAi.ts`)
- [x] **Group verification** — "Request verification" wizard (X-signup style,
  one question per screen) + "Copy group ID" in group settings, owner/admin,
  non-space. `POST /conversations/:id/verification-request` with
  `{purpose, link?, note?}`. Android: `ui/group/VerificationWizard.kt`.
- [x] **Invite join cards in chat** — `type:'link'` embeds now carry an
  additive `invite` object (code, title, memberCount, avatar…). iOS currently
  ignores it and renders a plain unfurl. Android: `ui/chat/InviteEmbedCard.kt`
  ("YOU HAVE BEEN INVITED TO JOIN" card with Join button).
- [x] **Explore, the rich version** — `GET /conversations/discover` returns
  `q` search, `hereCount`, `live`, `badge`, `createdAt`, `appearance`.
  Android renders sections: Verified / Buzzing now / New places / More, flair
  gradient cover bands, LIVE chip, search with debounce, empty state with a
  "Start a group" door. iOS still shows the flat legacy list.
- [x] **Edit profile** — display name / bio / pronouns / **flair** (two-stop
  gradient, `PATCH /users/me {flair:{gradient:[..]}}`), with a live preview.
  Android: `ui/settings/ProfileSheets.kt`.
- [x] **Profile page upgrades** — pronouns beside the username; **mutual
  groups pill** ("2 groups in common · movie night 🍿") from the additive
  `mutualGroups` field on `GET /users/:id`; flair gradient as the banner
  fallback; Share profile / Block / Report in a top-right overflow.
- [ ] **Mention-entity support check** — Android sends
  `entities:[{type:'mention',…}]`; confirm the iOS composer emits the same
  for @yapper detection (text fallback exists server-side, entity is better).
- [x] **`#channel` signposts** — all three clients. Typing `#` offers the
  channels you can see, the chip opens that channel on tap. The picker list is
  server-filtered and the title is resolved *per reader*, so a signpost to a
  private channel stays plain text for anyone who cannot open it. iOS and
  Android both scan the visible channel list at send time rather than only
  what the picker inserted, matching how each already handles role names.

- [x] **Create a private channel from a phone** — the Private chip in the new
  channel form on both, plus the create error actually surfacing instead of the
  button silently doing nothing. Private needs MANAGE_ROLES on top of
  MANAGE_CONVERSATION, so silent failure was the likely outcome.

- [x] **Apps: what a bot may do here** — the installed list and its grant, in
  the Bots section of group settings on both. Presets rather than the web
  panel's forty checkboxes, matching how the role editor beside it already
  handles the same problem. Readable by any member, changeable by admins.

## Feature parity — needs iOS-side building (server shared)

- [x] **Typing bubble in the timeline** — the animated three-dot bubble at
  the bottom of the chat (not just "X is typing" in the header). Built new
  on Android; iOS never had it either.
- [x] **Unread divider + jump-to-latest FAB** — "New messages" line at the
  read watermark, and a floating arrow with an unseen-count badge when
  scrolled up.
- [x] **Swipe conversation rows** — right = pin/unpin, left = archive.
- [x] **Full emoji reaction picker** — the quick-eight strip gains a "+"
  opening the full grid (same vocabulary as the composer's emoji tab).
- [x] **Media viewer: save to gallery** — real save (bytes → Photos), not
  open-in-browser; and the pager should include **every** image of an album
  message, not just the first.
- [x] **Campfire countdown on the conversation card** — 🔥 chip with
  remaining time (amber, red under an hour). iOS shows campfire state only
  inside the chat, same as Android did before this.
- [x] **Chat flair wash** — a faint vertical gradient of the group's flair
  at the top of the scrollback; group-specific "room" feel.
- [x] **People in home search** — search box results include a "People on
  yappy" section (`GET /users?q=`) alongside local filtering and message
  FTS hits. Also fix (if present on iOS): empty state must not win over
  non-empty server hits.
- [x] **Share profile QR** — QR of `yappy://user/<id>` + share sheet; iOS
  needs the `user` case in `DeepLink.swift` (Android's parser gained it —
  keep the two in step, the files cross-reference each other).
- [x] **Settings polish** — Edit/Share rows on the profile card; destructive
  actions folded into the Account section; icons on privacy pickers.
- [x] **Verified-group affiliate gating** — affiliate options in group
  settings only shown once the group is verified (server enforces; UI should
  match).
- [x] **Announcement embed icon** — Android swapped 📣 for a tinted
  `Campaign` icon; expandable embed descriptions ("Show more") instead of
  hard truncation. Cosmetic, but the truncation fix matters for parity of
  long announcements.
- [ ] **Empty-state pass** — chat ("It's quiet in here" + group emoji),
  invite manager, archived list. Match Android's tone.
- [x] **The group pet** — every group has a pixel dog/cat fed by the group's
  own conversation (server computes everything; additive `pet` object on
  conversation payloads: name/stage/mood/streak/fedDays). iOS needs the
  sprite renderer (`ui/components/PixelPet.kt` is the reference — 16×16
  char-grid sprites, species from conversation-id hash so both platforms
  agree), a chip on the conversation card, and the pet block + naming sheet
  on the group page (`PATCH /conversations/:id/pet`).

## Platform equivalents — different tech, same outcome

- [ ] **Communication notifications** — Android ships MessagingStyle with
  inline reply, mark-as-read, conversation shortcuts, share-sheet targets
  and bubbles. iOS equivalents: `UNNotificationCategory` reply actions,
  communication notifications (`INSendMessageIntent` donation) so avatars
  and conversation grouping appear, and Focus/share-sheet suggestions.
- [ ] **Who's-here widget** — WidgetKit twin of the Glance widget (places +
  live presence counts, reading the snapshot cache first).
- [ ] **Push: silent-channel semantics** — worker now sends FCM data-only
  with channel resolved server-side; APNs path untouched by design. When iOS
  reopens, consider mirroring the "_silent" channel choice for notification
  grouping.

## Deliberately NOT ported

- **Calling stays off on iOS** until the review strategy changes
  (`Features.calling = false`) — the VoIP push registry is not created, and
  that must not change casually: an iOS app that receives a VoIP push and
  does not report a call gets killed.
- Splash screen / predictive back / themed icon — Android-platform concepts
  with no iOS meaning.

---

*Maintain this file: when an Android-only feature ships, add a line; when
iOS catches up, tick it off. The commit log is the authority — this is the
readable index of it.*
