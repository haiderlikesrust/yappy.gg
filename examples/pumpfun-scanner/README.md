# pump.fun scanner

Paste a contract address into any group this bot is in and it replies with a
card: market cap, ATH, age, whether it has bonded, and a Refresh button.

About 200 lines, most of it comments. The parts worth copying are marked.

## Run it

```bash
pnpm install
YAPPY_TOKEN=yb_… YAPPY_WEBHOOK_SECRET=whsec_… pnpm --filter @yappy/example-pumpfun-scanner start
```

Then point the bot's webhook at `https://your-host/` and add it to a group.

| Variable | |
|---|---|
| `YAPPY_TOKEN` | Bot token. Shown once, when you create the bot. |
| `YAPPY_WEBHOOK_SECRET` | Shown once, when you set the webhook URL. |
| `YAPPY_API_URL` | Optional. Defaults to production. |
| `PORT` | Optional. Defaults to 8787. |

Both secrets are read from the environment and never written to disk. If either
one ends up somewhere it should not — a log, a paste, a screen share — rotate
it rather than hoping.

## Setting the bot up

1. Create the bot: `/login` to yapper, then the developer portal, or
   `POST /v1/apps`. Mark it **public** if you want it addable from the picker.
2. Set its webhook to where this process is reachable. Test with `/webhook`.
3. Add it to a group: group settings, **Bots**, *Add a bot*.

A bot only receives messages from conversations it is a member of. There is no
way to listen to a group without visibly being in it, which is deliberate.

## The four things worth stealing

**Build the card from fields, not one long description.** Clients cap an embed
description at eight lines and ellipsise the rest, so a stats block written as
one paragraph gets cut in half on a phone. Fields are not capped and lay out
two-up. `card.ts` does this, and it is the single most common way a card ported
from another platform comes out wrong here.

**Answer fast, work after.** The platform allows five seconds and retries a slow
reply with backoff, so a handler that does its work inline gets retried while
still working and processes the same event twice. `createHandler` returns the
200 first and runs your message handler after; you do not have to arrange it.

**Send a nonce.** A retried delivery would otherwise post the card twice. The
scanner uses `scan_<messageId>_<mint>`, which is stable across retries, so the
duplicate resolves to the message that already exists.

**Verify the raw body.** The signature is over the exact bytes sent. Re-encoding
a parsed object reorders keys and fails to verify in a way that looks exactly
like a wrong secret. This is why the server here collects raw chunks rather than
using a JSON body parser.

## Things this deliberately does

Stays quiet on anything that is not a coin. Most strings matching the address
shape are not tokens, and a 404 is the expected outcome rather than an error.

Ignores an address it has already answered in the same conversation for ten
minutes, so a thread about one coin does not become five identical cards.

Posts no image for a token flagged `nsfw` or `is_banned`. Anyone can mint
anything, and a scanner that renders every image it is handed will eventually
put something in a group chat that nobody there asked to see. The stats still
post; the picture does not.

Caps at two addresses per message, so a wall of pastes is not a wall of cards.
