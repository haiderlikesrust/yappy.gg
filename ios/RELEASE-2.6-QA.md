# iOS 2.6 — the place is live

The iOS changes add app-owned drop-in voice, channel seats and speaking rings,
voice channel creation, a persistent join/mute/speaker/leave bar, All / Places /
People / Unread filters, shared quiet headers, and the group affiliates roster.
The existing settings overview and WidgetKit extension are retained. Widgets
now include spaces, use the correct small-widget tap target, and show when the
snapshot was updated. Four pinned/recent conversations become home-screen quick
actions, including cold-launch routing.

Bug fixes cover failed/repeated microphone changes, repeated audio teardown,
late voice joins after leave or account switching, failed push registration and
re-registration after login, stale archive responses, late profile/token/cache
responses after logout, and incorrect verification-decline notification copy.

The follow-up fixes keep tab-bar visibility on the persistent navigation stack,
give the home bell's numeric count its own bounds, and refresh the app icon's
badge instead of clearing it on foreground. Inbox notices and mentions have
independent cursors, retry, swipe/context-menu dismissal, and selective read
acknowledgement. Mention dismissal is device-local and scoped to the account;
notice dismissal uses the server endpoint.

The Share extension sends text, web links, photos and files to a recent group
or space channel. Its draft is frozen once sending starts so retries use the
same nonce and uploaded media. The sheet stays open until sending succeeds.
It honours app lock, streams uploads from temporary files, and uses an atomic
shared keychain record plus a cross-process token-refresh lease. The widget
and notification service cannot access that keychain group.

Broadcast mention settings use the confirmed `broadcastMentions` field. Missing
means enabled; disabled broadcasts remain ordinary messages under All and do
not interrupt under Mentions. Direct mentions are unaffected. Group and space
screens show reading/voice activity with Open/Join actions. Activity is loaded
on open, foreground and relevant existing gateway events, with a manual refresh.
The activity contract covers reading and voice; it does not publish music or
custom streaming activities.

Floating status bubbles sit above home-row avatars and beside profile avatars.
Your own home avatar opens a shared status editor (also used in Settings), with
Save, Clear, a 128 UTF-16-unit limit that preserves whole emoji, and one-hour /
24-hour / until-cleared expiry. Friends' visible avatars read status through
the existing privacy-filtered profile endpoint; the online roster has no status
text. Visible bubbles refresh at most once a minute and on relevant events.
They keep no separate status disk cache. Failed saves keep the draft and show
an error; a late profile load cannot overwrite a newly saved status.

## Server contracts consumed

- `POST /conversations/:id/voice/join`: `token`, `url`, `participants`.
- `POST /conversations/:id/voice/leave`.
- Channel list: `isVoice`, `voiceParticipants`; gateway `voice.state`:
  `spaceId`, `channelId`, `participants`.
- `GET /conversations/:id/affiliates`: `affiliates` containing member entries.
- `GET /conversations/:id/verification-request`: nullable `request` containing
  `status` (`open`, `approved`, `declined`), and nullable `badge`.
- Notice pushes with `notificationId`, a notification `kind`/`type`, or a
  `targetType` open the notification centre. Message pushes retain chat routing.
- `GET /social/notifications`: `nextCursor`, `supportsSelectiveRead`.
- `POST /social/notifications/read`: `{ids: [...]}` (at most 100 per request).
  A server without `supportsSelectiveRead` receives no automatic read call.
- `DELETE /social/notifications/:id`; `GET /users/me/mentions?before=...`.
- `PATCH /users/me/settings`: `notifications.broadcastMentions` boolean.
- `GET /conversations/:id/activity`: `reading` and `inVoice`, each containing
  `{conversationId, title, userIds}`. Space results are filtered through the
  accessible channel list, and the caller is removed from both arrays.

Voice counts on the home list reflect channel snapshots and received voice
events. The initial gateway roster still needs the server-side voice snapshot
work; this client does not invent an occupied-room count before receiving one.
Push delivery and feeding the pet from voice remain server responsibilities.

## Share extension signing

Register `gg.yappy.app.share` for team `U5N92J3JMV`, with App Group
`group.gg.yappy.app`. Enable Keychain Sharing on the app and Share extension for
`$(AppIdentifierPrefix)gg.yappy.app.shared`; retain the app's original
`$(AppIdentifierPrefix)gg.yappy.app` group for legacy credential migration.
The project embeds `YappyShare.appex` and supplies both entitlements/plists.

## Validation

Windows source review and Swift tree-sitter checks found no new leaf syntax
diagnostics against the pre-2.6 baseline. The Xcode project references, shared
scheme, test target, plists and entitlements were parsed successfully.
These checks do **not** compile SwiftUI or validate Apple/LiveKit SDK types.

The `YappyTests` target is included in the shared `yappy` scheme. On a Mac:

```sh
xcodebuild -project ios/Yappy.xcodeproj -scheme yappy -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
```

XCTest and device checks have not been run on this Windows machine. Before
shipping, verify:

- Two phones join the same voice channel and hear each other. Check speaking
  rings, denied microphone permission/listen-only, mute, speaker and Bluetooth.
- Switch channels rapidly; leave during permission, joining and reconnecting;
  lock the phone, change tabs, and sign out. No departed seat or audio revives.
- In a calling-enabled test build, answer/start/end a CallKit call while in
  voice. Only one transport owns audio. Normal phone interruptions also recover.
- Verify all three widget sizes in light/dark mode, stale snapshot labeling,
  space/chat destinations, and widget/quick-action clearing after sign-out.
- Open shortcuts from a terminated and a running app; switch accounts and
  confirm an old account's action cannot open a conversation for the new one.
- Check narrow screens and accessibility text sizes: four filters scroll;
  headers, affiliates, settings overview and the connected bar remain usable.
- Trigger verified/affiliate/role/declined notices while foreground/background;
  tap into the inbox. Simulate a failed token registration and retry foreground.
- Submit verification, dismiss the wizard, and see Pending. Decline externally,
  return to settings, and see Declined with a request-again action.
- Push/pop chat repeatedly, including an interactive back gesture cancelled
  halfway, in each tab and while connected to voice. Check for tab-bar flashes.
- Verify bell counts 1 / 10 / 99 / 100+ on small screens. Load over 40 notices
  and mentions, fail either source, retry and refresh at the end of each feed.
  Unloaded notices must remain unread; dismiss one row and reopen the inbox.
- Share from Photos, Safari and Files. Test multiple images, PDF, an oversized
  file, text, a link, unavailable/readonly channels, app lock, expired access
  tokens, and a connection lost during send. Retry must not duplicate a message.
- Upgrade an existing installation and share before/after the app refreshes its
  token. Sign out during a share; no refresh may restore the signed-out session.
- Broadcast switch: absent field defaults on; off + All stays an ordinary
  notification; off + Mentions stays quiet; a personal mention still arrives.
  Failed setting writes must not appear saved.
- Open a space with people in several text/voice channels. Check names/counts,
  Open/Join, empty responses, hidden channels, ambient-presence opt-out, and
  gateway reconnect/foreground refresh. No music activity is inferred.
- Check status bubbles with empty, short, long and emoji-only text, light/dark
  appearance, and larger text sizes. Your bubble opens the editor; a friend's
  bubble opens their profile and their avatar still opens chat. Test saving,
  clearing, expiry, hidden last-seen, offline saves, and a returning foreground.

Marketing version is 2.6.0, build 27. Ringing calls retain the existing
`Feature.calling` flag; drop-in voice channels are independently available.
