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
| `yappy.gg` | Landing page, and the developer portal at `/portal` | Static files from disk; no app server |
| `www.yappy.gg` | Redirects to the apex | One canonical URL |
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

---

## Updating

```bash
git pull
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

The build reuses cached layers, so a code-only change rebuilds in seconds.
Migrations are idempotent and re-run on every deploy.

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

**`SMS_PROVIDER=console` prints login codes into the logs.** `env.ts` refuses to
boot in production with it set, which is the intended behaviour — configure
Twilio rather than working around the check.

**Push needs a Firebase project.** The server side is complete, but the Android
client needs a `google-services.json` and the worker needs the FCM service
account. Until both exist, notifications are silently not delivered.

**Calls are unverified.** The LiveKit integration is written and compiles but
has never run against a real SFU. Expect to debug it the first time.

**Object storage will outgrow the VPS disk.** MinIO here is the simple choice,
not the durable one — it is a single disk with no replication. Moving to
Cloudflare R2 is a change of four environment variables and no code, because
the presign path is the same; do it before the media matters.
