# yappy — Android client

Kotlin · Jetpack Compose · neumorphic design system · light and dark.

Talks to the backend in `../` over REST and the WebSocket gateway. Built and
run against a real emulator: sign-in, conversation list, chat, live message
delivery over the socket, and settings are all verified working.

## Running it

Needs the backend up first (`pnpm dev` in the repo root) and JDK 17+.

```bash
./gradlew :app:assembleDebug
```

```bash
./gradlew :app:installDebug
```

`local.properties` points at your Android SDK; regenerate it if you move the
SDK.

### Host addresses

`app/build.gradle.kts` sets these per build type:

| | Debug | Release |
|---|---|---|
| API | `http://10.0.2.2:3000/v1` | `https://api.yappy.gg/v1` |
| Gateway | `ws://10.0.2.2:3001` | `wss://gateway.yappy.gg` |

`10.0.2.2` is the host machine as seen from the emulator. On a **physical
device**, either change those to your machine's LAN IP or run:

```bash
adb reverse tcp:3000 tcp:3000
```

Cleartext HTTP is permitted only for `10.0.2.2`, `localhost` and `127.0.0.1`
(see `res/xml/network_security_config.xml`); everything else requires TLS in
both build types.

### Signing in

Run `pnpm db:seed` in the repo root, then sign in as `+15550000001`
(`@ada`) — the verification code is printed in the worker's log, since
`SMS_PROVIDER=console`.

## Structure

```
data/       Models, ApiClient (single-flight refresh), YappyRepository, GatewayClient
ui/theme/   NeuColors, the neu() modifier, Theme, Typography
ui/components/  NeuSurface, NeuButton, NeuIconButton, NeuTextField, NeuSwitch, Avatar
ui/auth/    Phone → code → handle
ui/conversations/  List with live patching from gateway events
ui/chat/    Messages, composer, sticker/GIF/emoji picker, polls, reactions, pins
ui/newchat/ · ui/profile/ · ui/settings/ · ui/call/
AppContainer.kt  Manual DI, provided through a CompositionLocal
```

## The design system

Soft-UI, not full neumorphism. The style's own rule is "few raised elements per
screen", and a chat app breaks it by definition — dozens of bubbles each
casting two shadows reads as a wall of pillows. So the system splits the world
in two:

- **Chrome is soft.** Composer, buttons, nav, search, cards, the switch: these
  keep the neumorphic treatment, at roughly half strength (`Neu.kt` defaults to
  `intensity = 0.55` with a wide, faint blur).
- **Content is flat.** Message bubbles, reaction pills, list rows, avatars,
  badges, day separators: flat tinted fills, no shadows. Hierarchy comes from
  colour — outgoing is the accent, incoming is `NeuColors.incoming`, one step
  off the surface.

Within the chrome, neumorphism's base rule still holds: **the surface, the
highlight and the shadow all derive from one base colour**, so `NeuColors` has
no Material 3 elevation ladder. Three states carry the vocabulary:

- **Raised** — shadows outside the shape. Buttons at rest, cards, the FAB.
- **Pressed** — the same two shadows inside. Inputs, active toggles, buttons
  while held.
- **Flat** — no shadows. All content, and anything inside a recessed container.

Compose has no inner-shadow primitive, so `Pressed` is drawn by hand in
`ui/theme/Neu.kt`: fill the shape with the shadow colour, then punch the shape
back out with a blurred `DST_OUT` pass offset in the light direction. What
survives is a soft band hugging one inside edge.

Two decisions that matter for it not to look wrong:

- **No ripples.** A ripple over a soft-shadowed surface reads as a smudge.
  Every interactive component animates Raised → Pressed on touch instead; the
  state change *is* the feedback, and it matches the physical metaphor.
- **The dark theme is not near-black.** `#22262E` leaves room above it for the
  highlight to read. On `#101010` there is nowhere for the light shadow to go
  and every element looks embossed on one side only.

## Client behaviour worth knowing

- **Optimistic sends.** A client-generated nonce is used as the local message
  id, so the server's copy replaces the placeholder rather than appearing
  beside it. A retry with the same nonce returns the original message.
- **Cursors on IDENTIFY.** The client sends its per-conversation `seq` cursors,
  so READY is a delta. On an account with hundreds of chats this is the
  difference between megabytes and kilobytes per reconnect.
- **RESUME before IDENTIFY.** A socket that comes back inside the server's 120s
  window replays only what it missed.
- **The socket is never the source of truth.** Reconnecting triggers a REST
  reconcile; events are a latency optimisation.
- **Single-flight token refresh.** Six requests hitting 401 at once produce one
  refresh, not six competing rotations.

## Not wired up

- **Call media.** Signalling, the participant roster, ring/decline/hangup, mute
  state and the call record in the thread all work. The backend returns a
  LiveKit room and a scoped join token; attaching `io.livekit:livekit-android`
  to those two values is the remaining step, marked at `CallScreen.attachMedia`.
  The screen says so on-screen rather than pretending to be connected.
- **Attachment upload.** Media *rendering* works; the presign → PUT → confirm
  flow from the camera/gallery is not built.
- **FCM.** Notification channels are created and the token endpoint exists; the
  Firebase service is not registered.
- **Offline cache.** State is in-memory plus the sync endpoint. Room would be
  the next addition.
- **Tests.**
