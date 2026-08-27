# Utility bot

A small bot for yappy groups: reminders, timers, time zones, quick charts, and
settling arguments. Built on [`@yappydotgg/bot-sdk`](https://www.npmjs.com/package/@yappydotgg/bot-sdk).

No API keys, no accounts, no external services. Everything it does is arithmetic
and `Intl`, which means it also works on a laptop with no inbound network.

```
/remind 20m take the pizza out
/remind at 9pm call mum
/reminders
/timer 10m standup
/time 3pm PT
/time Tokyo
/chart bar mon=3 tue=5 wed=9
/pick pizza | sushi | tacos
/help
```

## What each one does

**`/remind`** takes the time first, then what to remind you of: `20m`, `1h30m`,
`at 9pm`, `tomorrow 8am`, optionally with a zone (`at 3pm PT`). It says back what
it understood, because a reminder you do not trust gets set twice. The card has
a Cancel button only the person who set it can press. Reminders survive a
restart — anything that came due while the bot was down fires as soon as it is
back, late and saying so, which is better than never.

**`/timer`** posts a countdown card that rewrites itself, then says when it is
up. Rewrites are edits, and edits never push anyone's phone, so a ticking card
is not a ticking notification.

**`/time`** answers the group-chat question. `/time Tokyo` is what time it is
there; `/time 3pm PT` is what that instant reads as everywhere else.

**`/chart`** draws numbers somebody pasted: `mon=3 tue=5`, `mon: 3, tue: 5`, or
bare `3 5 9`. The numbers go in as fields too — a chart nobody can render still
has to say something.

**`/pick`** chooses one, using the system random source rather than
`Math.random`, because it exists to settle arguments.

## Running it

Create the bot at [yappy.gg/portal](https://yappy.gg/portal) — the token is shown
once — then:

```bash
npm install
cp .env.example .env    # put the token in it
npm start
```

Add the bot to a group from the group's member list. It answers in any
conversation it is in, and declares its commands to the composer on boot, so
`/rem…` autocompletes before it has ever spoken.

| Variable | Default | What it is |
| --- | --- | --- |
| `YAPPY_TOKEN` | — | The bot token. Required. |
| `YAPPY_API_URL` | production | Point at `http://localhost:3000/v1` for a local stack. |
| `YAPPY_GATEWAY_URL` | production | `ws://localhost:3001` locally. |
| `UTILITY_DATA` | `./data/state.json` | Where reminders live between restarts. |
| `UTILITY_TZ` | `UTC` | The zone the bot thinks in: what `9pm` means with no zone given. |

For production, `npm run build` then `npm run serve` under whatever keeps it
alive — the socket reconnects on its own, so a process manager is all it needs.

## Notes for anyone reading it as an example

The interesting parts, in the order they will matter to you:

- **`src/index.ts`** — the whole wiring: connect, route `/word`, ignore other
  bots. The bot ignores slash words it does not own, so it can share a group
  with other bots without arguing.
- **`src/reminders.ts`** — persistence, chained timers past `setTimeout`'s
  24-day ceiling, and firing a mention that actually notifies.
- **`src/clock.ts`** — parsing time the way people type it, and doing zone
  arithmetic with nothing but `Intl`.
- **`src/api.ts`** — the two endpoints the SDK does not wrap yet: who am I, and
  declaring commands.

`scripts/local-test.mjs` drives the whole thing against a local stack: it makes
a throwaway bot and group, types every command, and prints what came back.
