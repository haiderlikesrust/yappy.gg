# Android 2.6 deployment and testing

The Android build is 2.6.0 (15). Debug installs are named **yappy Dev**, use the
local API, and have package `gg.yappy.app.debug`. Release uses `gg.yappy.app`.
About → Copy support details as JSON identifies the installed build and records
device, display, version-check and connection information without credentials.

## Backend rollout

Deploy the matching API and apply `pnpm db:migrate` before installing the release.
Migrations 0006 and 0007 add personal folders and shared albums. Group albums
reference existing messages; message deletion, expiry and access restrictions
still apply. The new API also accepts attachment captions and spoiler flags.

## Self-hosted voice transcription

Transcription is disabled until `TRANSCRIPTION_BASE_URL` is configured. It uses
an OpenAI-compatible service running on your own VPS, after the listener taps
Transcribe and accepts the dialog. The transcript is returned to that listener;
Yappy does not save it as a message. Encrypted messages are excluded. Requests
are limited to 25 MB / 10 minutes, one per account and two concurrent jobs per
API process, with a two-minute service timeout.

For the repository's Docker production stack, add to `.env.production`:

```dotenv
TRANSCRIPTION_BASE_URL=http://speaches:8000/v1
TRANSCRIPTION_MODEL=Systran/faster-whisper-small
TRANSCRIPTION_API_KEY=
```

Start the optional CPU service from the deployment checkout:

```sh
docker compose --env-file .env.production -f docker-compose.prod.yml -f docker-compose.transcription.yml up -d speaches
docker compose --env-file .env.production -f docker-compose.prod.yml -f docker-compose.transcription.yml exec speaches uvx speaches-cli model download Systran/faster-whisper-small
docker compose --env-file .env.production -f docker-compose.prod.yml -f docker-compose.transcription.yml up -d --force-recreate api
```

The service shares the backend network and publishes no port. The first model
download needs internet access and disk space. CPU speed and RAM determine
whether longer notes finish before the timeout; test with representative audio
before enabling this for everyone. `SPEACHES_IMAGE` can pin a tested image digest.

For an API running directly on the VPS instead of Docker, run the service with
a loopback-only port (`127.0.0.1:8000:8000`) and use
`TRANSCRIPTION_BASE_URL=http://127.0.0.1:8000/v1` in that API's environment.
Restart the API after changing its environment. Do not expose the model service
through Caddy or the public firewall. `TRANSCRIPTION_API_KEY` is only needed if
your chosen self-hosted service is configured to require one.

Upstream references: [installation](https://speaches.ai/installation/) and
[speech-to-text](https://speaches.ai/usage/speech-to-text/).

## Device acceptance checks

- Pick multiple photos/videos; reorder, remove, caption and send one album.
- Crop/rotate/add photo text; create a sticker; trim/mute a video; compare quality.
- Leave the chat during an upload; cancel, retry and discard; verify one message.
- Check gallery categories, pagination and group album contribution/removal.
- Reveal spoilers in chat and gallery; confirm catch-up previews do not reveal them.
- Create/edit/delete folders; compare unread counts and verify chats remain intact.
- Set an expiring status and audience; check from a second account and after expiry.
- Clear selected cached media/by chat; confirm server originals remain accessible.
- Transcribe a short note with the deployed service, then test failure and timeout.
- Check all screens in both themes and with larger system text.

The backend regression harness uses a disposable database and a local mock
transcription endpoint; it does not verify speech recognition or VPS capacity.
