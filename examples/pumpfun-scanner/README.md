# pump.fun scanner

Paste a contract address into any group this bot is in and it replies with a
card: market cap, ATH, a bar of now-vs-ATH, age, whether it has bonded, and a
Refresh button. The card rewrites itself every thirty seconds for ten minutes.

About 200 lines, most of it comments. The parts worth copying are marked.

## Run it

```bash
pnpm install
YAPPY_TOKEN=yb_… pnpm --filter @yappy/example-pumpfun-scanner start
```

That is the whole setup. The bot dials out and holds the connection open, so
this runs on a laptop behind NAT: no public address, no certificate, no tunnel,
and no webhook to configure.

| Variable | |
|---|---|
| `YAPPY_TOKEN` | Bot token. Shown once, when you create the bot. |
| `YAPPY_API_URL` | Optional. Defaults to production. |
| `YAPPY_GATEWAY_URL` | Optional. Defaults to production. |

The token is read from the environment and never written to disk. If it ends up
somewhere it should not — a log, a paste, a screen share — rotate it rather than
hoping.

## Setting the bot up

1. Create the bot: `/login` to yapper, then the developer portal, or
   `POST /v1/apps`. Mark it **public** if you want it addable from the picker.
2. Add it to a group: group settings, **Bots**, *Add a bot*.

Leave the webhook URL empty. A socket and a webhook both deliver everything, so
a bot with both configured answers every message twice.

A bot only receives messages from conversations it is a member of. There is no
way to listen to a group without visibly being in it, which is deliberate.

## The things worth stealing

**Build the card from fields, not one long description.** Clients cap an embed
description at eight lines and ellipsise the rest, so a stats block written as
one paragraph gets cut in half on a phone. Fields are not capped and lay out
two-up. `card.ts` does this, and it is the single most common way a card ported
from another platform comes out wrong here.

**Send a nonce, and keep it under 64 characters.** A retried delivery would
otherwise post the card twice. The scanner uses `scan_<messageId>_<mint[0..8]>`
— the whole address plus a message id is 86 characters and the send is refused,
which is exactly the bug this example shipped with.

**Keep your units straight.** `market_cap` from pump.fun is denominated in SOL
and `usd_market_cap` is the one people mean. Printing an ATH in SOL next to a
market cap in dollars makes every token look like it collapsed. The bar chart
uses the same conversion, so the picture and the fields agree.

**Let `live()` rewrite the card.** A Refresh button is still there for after
the ten-minute window, but the interesting minute after a paste should not
need a tap. `bot.live` posts once and edits after that, so phones do not
buzz every thirty seconds. A webhook bot with no process to keep alive cannot
do this — that is what the button is for.

## Webhooks instead

If your bot is a serverless function with no process to keep alive, set a
webhook URL and use `createHandler` from the SDK. Two things to know: verify the
**raw** body, because the signature is over the exact bytes sent and re-encoding
a parsed object fails in a way that looks like a wrong secret; and pass the
handler your `bot` client, because a press is answered by calling the API back,
not by what you return from the HTTP response.

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
