# yappy — iOS client

Swift · SwiftUI · the same neumorphic design system as the Android app, light
and dark.

A port of `../android`, feature for feature. It talks to the backend in `../`
over the same REST API and the same WebSocket gateway, with the same protocol
behaviours — optimistic sends keyed on a nonce, `seq` cursors on IDENTIFY,
RESUME before IDENTIFY, single-flight token refresh, and automatic failover to
the backup domain.

## Running it

Xcode 16 or newer, iOS 17+ deployment target.

```bash
open ios/Yappy.xcodeproj
```

Then ⌘R. From the command line:

```bash
xcodebuild -project ios/Yappy.xcodeproj -scheme yappy -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build
```

The only dependency is the LiveKit Swift SDK, resolved by SwiftPM on first
build. Everything else — HTTP, the socket, image loading and GIF decoding — is
URLSession and ImageIO.

### Host addresses

`Data/Endpoints.swift` sets these per configuration:

| | Debug | Release |
|---|---|---|
| API | `localhost:3000`, then the release hosts | `api.yappy.gg` → `api.tenku.xyz` |
| Gateway | `localhost:3001`, then the release hosts | `ws.yappy.gg` → `ws.tenku.xyz` |

A debug build tries a local backend first and falls through to production if
nothing is listening, so the app is usable either way without editing anything.
The simulator shares the host's loopback, so plain `localhost` works — no
`10.0.2.2` indirection like the Android emulator needs.

Cleartext is permitted only for local networking (`NSAllowsLocalNetworking` in
`Support/Info.plist`); everything else requires TLS.

## Structure

```
Data/       Models, ApiClient (single-flight refresh + failover), YappyRepository,
            GatewayClient, SessionStore (keychain), AttachmentUploader,
            CallEngine + LiveKitTransport, HeaderSeeds
Theme/      NeuColors, the neu() modifier, typography
Components/ NeuSurface/Button/IconButton/TextField/Switch/Chip, Avatar,
            IdentityMarks, Flair, EditableAvatar, LogoMark, RemoteImage, Time
Features/   Auth · Conversations · Chat · Media · NewChat · Profile · Settings ·
            Group · Space · Explore · Call
App/        AppContainer (manual DI), RootView (routes), YappyApp
```

## The design system

The rules are the Android app's, unchanged — see `../android/README.md` for why
they are what they are. What differs is only how they are expressed:

- **Inner shadows are native.** Compose has no inner-shadow primitive and draws
  the pressed state by hand with a blurred `DST_OUT` pass. SwiftUI composes it
  into the fill: `shape.fill(colour.shadow(.inner(…)))`.
- **The blur factor is 1.2, not 2.1.** The two platforms mean different things
  by "radius". Android's `BlurMaskFilter` takes a radius it converts to roughly
  0.577σ; SwiftUI's `radius` *is* σ. 2.1 × 0.577 ≈ 1.2, so the same elevation
  produces the same shadow.
- **Squircles are `.continuous`.** Apple's curve is the one the shape language
  was reaching for anyway.

### Space Grotesk

The display face is a variable font whose only named instance is Light, so
weights are set on the `wght` axis rather than asked for by name. Naming a font
explicitly also opts *out* of the system font cascade, so `Typography.swift`
puts a cascade list back — without it every emoji and every non-Latin script
renders as a tofu box.

## Client behaviour worth knowing

Everything the Android README lists still holds. The iOS-specific parts:

- **Tokens live in the keychain**, with
  `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`: readable by a background
  push handler after a reboot, never in an encrypted backup, never restored onto
  a second device. The Android build notes this as the next step it had not
  taken; on iOS it is one API away, so it is done.
- **Foreground reconnects hard.** iOS freezes the process, so heartbeats stop
  and the server drops the session while `receive()` is suspended and never
  reports it. Coming back therefore tears the socket down and rebuilds it rather
  than calling `connect()`, which would see a non-nil handle and decline.
  `NWPathMonitor` does the same on a Wi-Fi/cellular switch, and a 15-second
  watchdog catches a handshake that never completes.
- **Read acks track the highest seq seen, and fall back to REST.** Rows report
  themselves as they appear, so scrolling up makes the newest call the *oldest*
  message; acking that would move the cursor backwards. And the socket silently
  drops sends while connecting — which is exactly when a chat opened from a cold
  start does its first ack.
- **Header seeds.** A list leaves the name and avatar behind before pushing a
  chat, so the header draws on the first frame instead of flashing a placeholder
  while its own fetch is in flight.
- **The image loader is hand-rolled.** `AsyncImage` cannot attach the
  `Authorization` header that private attachments need, and cannot animate GIFs.
  The token is sent only to our own hosts — attaching it to a Tenor URL would
  leak the session.

## Releasing to TestFlight

Signing needs an Apple Developer account, so the steps below have to be run by
someone holding it. Nothing here is checked in.

1. **Once, in the Apple Developer portal / App Store Connect:** register the
   bundle id `gg.yappy.app` and create the app record.
2. **In Xcode:** select the `yappy` target → Signing & Capabilities → check
   *Automatically manage signing* and pick the team. That writes
   `DEVELOPMENT_TEAM` into the project.
3. Put the team id into `Support/ExportOptions.plist`.
4. Archive and export:

```bash
xcodebuild -project ios/Yappy.xcodeproj -scheme yappy -sdk iphoneos -configuration Release -destination 'generic/platform=iOS' -archivePath build/yappy.xcarchive archive
```

```bash
xcodebuild -exportArchive -archivePath build/yappy.xcarchive -exportOptionsPlist ios/Support/ExportOptions.plist -exportPath build/export -allowProvisioningUpdates
```

5. Upload with an App Store Connect API key:

```bash
xcrun altool --upload-app -f build/export/yappy.ipa -t ios --apiKey YOUR_KEY_ID --apiIssuer YOUR_ISSUER_ID
```

Bump `CURRENT_PROJECT_VERSION` in the project for every upload;
`MARKETING_VERSION` only when the user-visible version changes.

### Before the first beta

- **`api.yappy.gg` does not currently resolve.** The app works anyway — it fails
  over to `api.tenku.xyz`, which is what that mechanism is for — but every cold
  start pays a failed DNS lookup first. Either restore the record or make the
  working domain primary in `Data/Endpoints.swift`.
- **Turn on Push Notifications for the app id** in the Developer portal, and
  give the worker its APNs `.p8` (`APNS_KEY_ID`, `APNS_TEAM_ID`,
  `APNS_PRIVATE_KEY`, and `APNS_PRODUCTION=true` for TestFlight — a TestFlight
  build uses the production APNs environment even though it is a beta).
- **Verify emoji on a real device.** They render as tofu boxes in the current
  simulator runtime — including in the simulator's own Safari, so it is not an
  app bug — but it is worth one look on hardware before testers see it.

## Push notifications

The worker already spoke APNs and its `APNS_BUNDLE_ID` defaults to
`gg.yappy.app`; `Data/PushService.swift` is the missing client half. It asks for
permission *after* sign-in — a prompt on the first screen, before the person has
seen a message, is the one most reliably denied, and iOS only lets you ask once
— then registers, hands the hex token to `PUT /devices/me/push`, and routes a
tap back into the conversation via `conversationId` in the payload.

A notification for the chat already on screen is suppressed: the message is
arriving over the socket and is already visible.

## Invite links

`POST /conversations/:id/invites` returns `https://yappy.gg/join/<code>`. Three
forms reach the app, all handled in `Data/DeepLink.swift`:

| Link | Works |
|---|---|
| `yappy://join/<code>` | immediately, no setup |
| `https://yappy.gg/join/<code>` | once the AASA file is deployed |
| `https://tenku.xyz/join/<code>` | same, on the backup domain |

Tapping one opens a preview sheet — whose group it is, how many members, how
many uses are left — and joins only when the person taps Join. A link that
silently adds you to a group is a link people learn not to tap.

For the `https://` forms, two things ship outside this directory:

- `web/.well-known/apple-app-site-association`, listing
  `U5N92J3JMV.gg.yappy.app` for the `/join/*` path only.
- One line in `infra/Caddyfile` serving that file as `application/json`. It has
  no extension for Caddy to infer a type from, and with `nosniff` set it would
  otherwise arrive as `octet-stream` and universal links would silently never
  verify.

Apple's CDN fetches the association file, so it must be reachable over TLS with
no redirect. `yappy.gg` not resolving will block verification on that domain
until the DNS record is back.
