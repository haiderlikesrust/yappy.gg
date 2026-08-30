# @yappydotgg/bot-sdk

The official SDK for [yappy](https://yappy.gg) bots. No dependencies — it uses
the `fetch` and `WebSocket` that Node already has.

```bash
npm i @yappydotgg/bot-sdk
```

A bot is an account. It joins a conversation, it holds permissions, and it is
refused the same things a person would be refused. If a person cannot pin a
message in a group, neither can a bot; if a bot can, it is because the group
granted it the same permission it would grant a person.

## A bot in twenty lines

```ts
import { YappyBot, EmbedBuilder, row, button, perms } from '@yappydotgg/bot-sdk';

const bot = new YappyBot({ token: process.env.YAPPY_TOKEN! });

bot.connect({
  async onMessage({ conversationId, message }) {
    if (!message.content?.includes('hello')) return;
    await bot.reply(conversationId, message.id, {
      embeds: [new EmbedBuilder().title('Hi').color('#8b7cff').build()],
      components: [row(button('wave', 'Wave back', 'primary'))],
    });
  },
  async onInteraction({ customId }) {
    return { kind: 'update', content: `pressed ${customId}` };
  },
});
```

Get a token from the developer portal at
[yappy.gg/developers](https://yappy.gg/developers). It is shown once.

## What is in here

**`YappyBot`** — the REST client: `send`, `reply`, `edit`, `remove`, `react`,
`unreact`, plus `connect()` to hold a socket.

**`EmbedBuilder`, `row`, `button`** — cards and the buttons under them. A
button can carry `requiredPermissions`, checked at press time against *the
person pressing*, never against the bot:

```ts
row(button('ban', 'Ban', 'danger', { requiredPermissions: 'BAN_MEMBERS' }));
```

**Charts.** An embed can draw its numbers: `line`, `area`, `bar`, `pie`,
`donut`, `scatter`. Two to twenty-four points. Write the same numbers as
fields — a client that has never heard of charts still has to make sense.

```ts
new EmbedBuilder()
  .title('Market cap')
  .field('Now', '$12.4K', true)
  .field('ATH', '$40.1K', true)
  .chart('bar', [
    { label: 'Now', value: 12_400 },
    { label: 'ATH', value: 40_100 },
  ])
  .build();
```

**`live()`** — a card that rewrites itself. The first render is the post;
every tick after that edits the same message, and edits never push a phone.

```ts
await bot.live(conversationId, {
  every: '30s',
  until: '10m',
  render: async () => renderCard(await fetchThing()),
});
```

It is a loop in your process, so it belongs with a socket bot rather than a
serverless webhook. `every` floors at ten seconds, `until` caps at 24 hours,
and a deleted message stops the loop.

**`feed()`** — a board channel, published by a program. A board reads as a
page of cards rather than a conversation, and a feed keeps one card on it
current for as long as your process runs.

```ts
await bot.feed(channelId, 'sol-price', {
  every: '10s',
  render: async () => ({ content: `**SOL** — $${await price()}` }),
  onError: (err) => console.error(err),
});
```

The card is addressed by the name you gave it, never by a message id — so a
restart, a redeploy, or a second replica writes to the same card instead of
posting another one beside it. That is the whole difference from `live()`,
and it is why a feed has no deadline. Markdown in `content` is parsed on a
board, so `**bold**`, `*italic*`, `` `code` `` and `[links](url)` work
without building entities by hand.

The first write is awaited and its failure is yours: a bad token or a
channel the bot cannot post in fails at the line that started the feed.
After that the loop looks after itself — a `render()` that throws skips a
tick and backs off, and only `403`/`404` (the channel is gone, or the bot
lost its permission) stops it. Call `bot.stopFeeds()` on `SIGTERM`.

Give the bot a role that can post there. A board carries the announcement
floor, so an ordinary member cannot write to it — moderator is the lowest
rung that can, or grant a named role the send permission.

Without the loop, `bot.card(channelId, name)` is the same thing one write
at a time — the right shape for a cron job or a lambda, which have no
process to keep alive:

```ts
await bot.card(channelId, 'sol-price').set({ content: `SOL — $${price}` });
await bot.card(channelId, 'sol-price').remove(); // retire it
```

**`perms`** — the permission bitfield without the arithmetic:

```ts
perms.has(invoker.permissions, 'KICK_MEMBERS'); // → boolean
perms.bits('KICK_MEMBERS', 'BAN_MEMBERS'); // → '12884901888'
perms.names(invoker.permissions); // → ['VIEW_CONVERSATION', …]
```

**`createHandler`, `verifySignature`** — for webhook bots. Signatures are
verified over the exact bytes received, so hand the handler a raw body, not
a re-encoded one.

Use a socket **or** a webhook, not both: each delivers everything, so a bot
holding both handles every event twice.

## The one rule

Authorisation is checked against the person who invoked an action, never
against the bot. A bot with every permission in a group still cannot ban on
behalf of someone who cannot ban.

## Documentation

- [Building bots](https://docs.yappy.gg/bots/) — the full guide
- [Bot API reference](https://docs.yappy.gg/bot-api/)
- [Permissions](https://docs.yappy.gg/permissions/)

MIT licensed.
