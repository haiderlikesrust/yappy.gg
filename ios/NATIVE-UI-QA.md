# Native iOS UI verification

These changes require an Xcode build and simulator/device validation on a Mac.
The Windows source check parses Swift syntax; it does not type-check Apple SDK
calls or verify layout. The deployment target remains iOS 18.

## Navigation and settings

- Open a chat, switch to Explore and You, then return. Each tab should retain
  its own destination and scroll position. Back should only pop that tab.
- Check the native tab/search/navigation bars on iOS 18 and the latest iOS.
  Check light/dark appearance, large accessibility text, VoiceOver, Reduce
  Motion and Reduce Transparency. Chat composers must stay above the keyboard.
- Check all six settings categories: Account, Privacy & safety, Notifications,
  Appearance, Storage, Devices. Change a preference, leave and return, and
  verify the saved value. Search from You should find categories by subtitle.
- Check notification permission denied/not-yet-requested states, including
  returning from iPhone Settings. About, support, sign-out and delete-account
  flows should remain reachable in their appropriate sections.

## Catch up and community tools

- Open Catch up from Chats, switch through Events, Reminders, Scheduled and Saved, then return to the same tab and navigation stack. Message jumps must land on the selected message.
- Create/edit/cancel an event as an admin; verify RSVP counts and local dates on a second account. Repeating an RSVP or editing the description must not repeat a reminder. Test notification delivery with the app closed.
- Schedule plain text from the attachment menu. A failed request must retain the draft; success clears it. Scheduling stays unavailable for encrypted conversations and while replying or editing. Check cancellation and suspension before send time.
- Save to a new/existing collection, edit a private note, search for it, and delete the collection. Existing notes must load before editing; failed requests must retain typed text. Collection deletion must keep the saved message.
- Configure welcome text, rules and a starting channel; confirm only accessible channels appear. Dismiss guidance and reopen the chat. Explore interests and language filters must match the configured group profile.
- Exercise these forms at large accessibility sizes in both themes, with VoiceOver and the keyboard visible. Test network failures and retries without duplicate submissions. A syntax check on Windows does not validate SwiftUI types or native behavior.

## Previews

- Long-press a DM and a group. The preview fetch must send no read acknowledgement
  or viewing/presence event. Unread/mention counts must remain unchanged.
- Encrypted messages remain labeled as encrypted in a preview; opening the
  chat should still decrypt normally. A preview must not replace the full
  cached history page. Check offline, deleted messages and empty chats.
- Open, Pin, Mute and Archive should still work. “Mark unread on this iPhone”
  is an account-scoped, device-local reminder, not a server read-cursor rewind.
  Check its dot, Unread filter, relaunch persistence and clearing when opened.
- Profile/group sheets should resize between medium and large, scroll at large
  height, and close to the same chat. Opening a member profile stays inside
  the sheet; opening a conversation or settings dismisses the sheet first.
- Explore preview must not join automatically. Check joining, failed joining,
  retry and successful navigation. Dismissal is disabled while joining.

## Calling — device testing only

`Feature.calling` stays `false` for release. Do not enable it until these pass
on physical iPhones using a test build and test accounts:

- Incoming/outgoing call, minimize, change tabs, open a profile sheet and return
  to the call: one CallKit session, one media transport, uninterrupted audio,
  shared mute/speaker state and a continuous duration.
- End from the mini-player, full screen and CallKit. The microphone, player
  and full-screen call should close. Repeat while joining/reconnecting and
  immediately redial; delayed callbacks must not revive an ended transport.
- End remotely with the gateway disconnected. Session-owned roster polling
  should still remove the player within its five-second polling interval.
- Check denied microphone permission, lock-screen answer, Bluetooth routing,
  interrupted audio, failed media connection, sign-out and CallKit reset.
