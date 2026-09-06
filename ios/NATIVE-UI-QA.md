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
