# Deploying yappy.gg to a VPS

Everything runs in one `docker compose` stack: Postgres, MinIO, LiveKit, the
three Node services, and Caddy in front doing TLS. No Redis — Postgres carries
the queue, the event bus, presence and rate limits.

A 2 vCPU / 4 GB box is enough to start. Postgres is configured for 512 MB of
shared buffers, so go to 8 GB before you have real traffic.

---

## 1. DNS first

Caddy requests certificates the moment it starts, and the request fails if the
name does not yet resolve to this machine. So point these at the VPS **before**
bringing anything up, and give them a few minutes to propagate:

All of these are `A` records (plus `AAAA` if the VPS has IPv6) pointing at the
same machine. Every one of them terminates at Caddy on ports 80/443; they are
separate names rather than paths because their traffic behaves differently —
ten-minute idle sockets, large media bodies, and ordinary short requests do not
share sensible proxy settings.

| Record | Serves | Why its own name |
| --- | --- | --- |
| `yappy.gg` | Landing page, the developer portal at `/portal`, the docs at `/docs`, invite links at `/join/<code>` | Static files from disk; no app server |
| `www.yappy.gg` | Redirects to the apex | One canonical URL |
| `app.yappy.gg` | The web client (`apps/webapp`) | A single-page app: every non-file path serves the shell, so `/c/<id>` survives a refresh. Built by the `webapp` one-shot into a volume Caddy serves. Its origin must be in `CORS_ORIGINS` or the client cannot call the API |
| `docs.yappy.gg` | Developer documentation | The same generated files, given their own root so `/bots/` works without the `/docs` prefix |
| `api.yappy.gg` | REST API | 2 MB body cap, health-checked upstream |
| `ws.yappy.gg` | WebSocket gateway | 10-minute read/write timeouts for idle chat sockets |
| `cdn.yappy.gg` | Object storage (avatars, attachments) | Immutable cache headers, large bodies |
| `rtc.yappy.gg` | LiveKit signalling | Long-lived signalling; the media itself bypasses Caddy |

Two things are deliberately *not* subdomains. WebRTC media goes straight to the
container over UDP 50000–50100, so no DNS name fronts it. And Postgres and the
MinIO console are not exposed at all — see the firewall section.

If you are bringing this up before the domain is ready, point `WEB_DOMAIN` and
friends at names that already resolve. Caddy fails to obtain a certificate for a
name that does not point here yet, and it will keep retrying noisily.

## 2. Firewall

```bash
ufw allow 22/tcp
ufw allow 80,443/tcp
ufw allow 7881/tcp
ufw allow 50000:50100/udp
ufw enable
```

The UDP range is WebRTC media and cannot go through the reverse proxy — that
traffic is peer-to-SFU and never speaks HTTP. `7881` is the TCP fallback for
clients on networks that block UDP. Note what is *absent*: 5432 and 9000 are
never published, so Postgres and MinIO are reachable only from inside the
compose network.

## 3. Configure

```bash
git clone https://github.com/haiderlikesrust/yappy.gg.git
cd yappy.gg
cp .env.production.example .env.production
```

Fill in every `CHANGE_ME`. Generate secrets properly:

```bash
openssl rand -base64 48
```

Two settings people get wrong, both of which fail only on a real device:

- **`DATABASE_URL` must use the host `postgres`**, not `localhost` — inside the
  network, `localhost` is the container itself.
- **`S3_PUBLIC_ENDPOINT` is not `S3_ENDPOINT`.** The services reach the bucket
  internally at `http://minio:9000`; clients are handed presigned URLs for
  `https://cdn.yappy.gg`. SigV4 signs the `Host` header, so a URL signed against
  the internal name is rejected when a phone uses it, and the failure looks like
  a network error rather than a configuration one.

## 4. Start

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

Migrations run as a one-shot `migrate` service that the app services wait on, so
a failed migration stops the deploy instead of crash-looping the API.

Check it:

```bash
docker compose -f docker-compose.prod.yml ps
curl https://api.yappy.gg/health
curl https://api.yappy.gg/ready      # also proves Postgres is reachable
```

## 5. Point the app at it

In `android/app/build.gradle.kts`, set the release `API_BASE_URL` and
`GATEWAY_URL` to your domains, then build a release APK. The app refuses
cleartext HTTP, so these must be `https://` and `wss://`.

## 6. Seed the yapper bot

yapper is not created by migrations — it is an account, and it needs an owner,
so it can only exist after the first human does. Register in the app (that
account becomes the bot's owner), then:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production \
  run --rm api node packages/db/scripts/create-yapper.mjs

docker compose -f docker-compose.prod.yml --env-file .env.production \
  run --rm api node apps/api/scripts/set-yapper-avatar.mjs
```

Both are idempotent — running them again is a no-op, and the second one can be
re-run after a rebrand to update the avatar. Without yapper, the developer
portal at `https://yappy.gg/portal` has nothing to approve sign-ins, and the
composer offers no slash commands.

---

## Updating

```bash
git pull
GIT_SHA=$(git rev-parse --short HEAD) BUILT_AT=$(date -u +%FT%TZ) \
  docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

The build reuses cached layers, so a code-only change rebuilds in seconds.
Migrations are idempotent and re-run on every deploy.

`GIT_SHA` and `BUILT_AT` are what `/version` reports back in yapper. Deploying
without them still works — they default to `unknown` — but then "is the fix
live?" goes back to being answered by guessing, which is the whole reason the
command exists. Worth putting in a shell alias.

## Backups

The only irreplaceable state is Postgres and the media bucket.

```bash
# Database
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U yappy yappy | gzip > "yappy-$(date +%F).sql.gz"

# Media
docker run --rm -v yappy_minio-data:/data -v "$PWD:/backup" alpine \
  tar czf /backup/minio-$(date +%F).tar.gz -C /data .
```

Put both on a cron and copy them off the box. A backup on the same VPS is not a
backup.

## Logs

```bash
docker compose -f docker-compose.prod.yml logs -f api
docker compose -f docker-compose.prod.yml logs -f worker    # push, unfurling
```

---

## Things that will bite

**There is no password reset.** Sign-in is email + password, addresses are not
verified, and nothing sends email. Someone who forgets their password has no
way back into their account. Building reset requires an email provider and
SPF/DKIM records on the sending domain — do this before real users exist,
because the first locked-out person is a support ticket you cannot resolve.

**Push needs a Firebase project.** The server side is complete, but the Android
client needs a `google-services.json` and the worker needs the FCM service
account. Until both exist, notifications are silently not delivered.

**Calls are unverified.** The LiveKit integration is written and compiles but
has never run against a real SFU. Expect to debug it the first time.

**Object storage will outgrow the VPS disk.** MinIO here is the simple choice,
not the durable one — it is a single disk with no replication. Moving to
Cloudflare R2 is a change of four environment variables and no code, because
the presign path is the same; do it before the media matters.
