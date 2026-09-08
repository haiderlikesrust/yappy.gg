# 2.6 server and Android hardening

## Changes

- Voice joins enforce channel visibility and JOIN_CALL. Private room rosters go only to permitted viewers, and SFU outages no longer erase seats.
- Voice tokens restrict publishing to the allowed track sources. Mute state is included on join and updated through `PATCH /v1/conversations/:id/voice/state` with `{isMuted: boolean}`. Updates and leaves from an older device cannot change the current device's seat.
- Android joins start muted at the media layer, apply the latest controls after connection, cancel safely on leave/switch, and clean up failed sessions. A persistent error bar offers Retry. Calls and sign-out retire the voice session.
- Voice foreground notifications cover connection setup and listen-only sessions. Notification actions are scoped to the session, and asynchronous actions retain the receiver until completion.
- Notification-centre notices now enqueue transactional pushes; Android renders them and opens the inbox. Worker push deduplication matches the partial database index.
- Account group/DM notification settings and broadcast preferences both apply. Notification paging preserves timestamp ties and database microseconds. Android acknowledges displayed notices, retries failed pages, and keeps successfully dismissed rows removed.
- Activity excludes private/deleted channels and the caller. Pet tending uses a complete UTC day, excludes bots from voice feeding, and keeps recently voice-active pets from wandering. Staff rejection resolves open verification requests.
- Conversation deep links resolve spaces/voice rooms before navigation. Failed parallel chat loads are contained rather than crashing the app.

## Automated verification

- API and worker TypeScript checks.
- `apps/api/scripts/release-2.6-check.mts`: local PostgreSQL integration checks, real route handlers and worker queries. All fixture writes roll back; SFU calls are stubbed and no pushes are delivered. Run from `apps/api` with `pnpm exec tsx --env-file=../../.env scripts/release-2.6-check.mts`.
- Android `:app:testDebugUnitTest` and `:app:assembleDebug`, including eight voice session regression tests.
- Emulator: inbox deep link, space deep link, unavailable conversation recovery, microphone denial, failed voice join, Retry, and foreground-service cleanup. This reproduced and fixed two crashes (parallel chat load failure and an early voice-service shutdown). The local SFU was unavailable, so this verifies failure recovery rather than audio delivery.

## Device checks before release

- Two physical phones: join the same room, verify bidirectional audio and roster mute state, then switch rooms and leave.
- Background and lock the phone while talking and while listen-only; exercise notification mute, speaker and leave. Grant microphone access after entering listen-only.
- Bluetooth/wired headset routing, interrupted Wi-Fi/cellular handover, incoming phone calls, and prolonged reconnects.
- Deliver centre notifications through configured APNs/FCM credentials. The local integration checks validate enqueueing, not provider delivery.
