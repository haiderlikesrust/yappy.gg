# Quickstart: your first bot in fifteen minutes

By the end of this you will have a bot that lives in a group, answers a slash
command with a rich card, and handles a button press. Everything runs on your
own machine. The only prerequisites are a yappy account, Node 20 or newer, and
a way to expose a local port to the internet for the webhook step.

If you want the reasoning behind any of it, [the bot guide](BOTS.md) covers the
same ground in depth. This page is the shortest path to something working.

## 1. Create the bot

Open [the developer portal](https://yappy.gg/portal) and sign in. The portal
shows you a code; take it to `@yapper` in the app, send `/login`, paste the
code, and press Confirm. That is the whole sign-in: the portal never asks for
your password, because the account that approves the request is already proven
by being signed in on your phone.

In the Your Bots tab, press Create. Give it a display name and an `@handle`.
The handle shares one namespace with human usernames, so nobody can register a
lookalike of an existing account.

Copy the token. It is shown exactly once, and it looks like this:

```
yb_9c1f8a2b...
```

Store it the way you would store a database password. If it leaks, rotate it
from the same tab, which invalidates the old one immediately.

## 2. Say hello

Every bot request uses the `Bot` scheme, not `Bearer`. Confirm the token works:

```bash
curl https://api.yappy.gg/v1/apps/me -H "Authorization: Bot yb_9c1f8a2b..."
```

```json
{
  "application": { "id": "app_...", "name": "Weather Bot", "isPublic": false },
  "user": { "id": "usr_...", "username": "weatherbot", "isBot": true }
}
```

Note the `user.id`. Your bot is an ordinary account: it will appear in member
lists, hold a role, and be subject to the same permissions as a person.

## 3. Put it in a group

A bot can only post where it is a member and holds `SEND_MESSAGES`. In the app,
open a group you administer, go to its members, and add the bot by its handle.

Now post something. `nonce` is required and is your idempotency key: if the
request is retried after a dropped connection, the second call returns the
original message rather than posting a duplicate.

```bash
curl -X POST https://api.yappy.gg/v1/conversations/<conversationId>/messages \
  -H "Authorization: Bot yb_9c1f8a2b..." \
  -H "Content-Type: application/json" \
  -d '{ "nonce": "hello-1", "type": "text", "content": "Hello from my first bot." }'
```

If you get a 403, the bot is not a member or the group has not granted it
`SEND_MESSAGES`. If you get a 404, check the conversation id: a conversation
you are not in is invisible rather than forbidden, so that non-membership does
not leak its existence.

## 4. Send a card instead

Bots may build rich embeds. People cannot, and that is deliberate: a card
anyone could author is the most effective phishing surface a chat product has.

```bash
curl -X POST https://api.yappy.gg/v1/conversations/<conversationId>/messages \
  -H "Authorization: Bot yb_9c1f8a2b..." \
  -H "Content-Type: application/json" \
  -d '{
    "nonce": "weather-1",
    "type": "text",
    "content": null,
    "embeds": [{
      "title": "Weather for London",
      "description": "Sunny with a light breeze.",
      "color": "#8b7cff",
      "fields": [
        { "name": "Temperature", "value": "24C", "inline": true },
        { "name": "Humidity", "value": "40%", "inline": true }
      ],
      "footer": { "text": "Updated just now" }
    }]
  }'
```

## 5. Declare a slash command

The composer offers autocomplete the instant someone types `/`, so commands are
declared ahead of time rather than fetched at keystroke time. A sleeping bot
must not make typing feel broken.

```bash
curl -X PUT https://api.yappy.gg/v1/apps/<applicationId>/commands \
  -H "Authorization: Bot yb_9c1f8a2b..." \
  -H "Content-Type: application/json" \
  -d '{ "commands": [
        { "name": "weather", "description": "Current weather for a city", "usage": "/weather <city>" }
      ] }'
```

Type `/we` in a group the bot is in and the command appears.

## 6. Hear about the world

So far the bot has only spoken. To listen, give it a webhook. Deliveries are
signed, queued, and retried five times with exponential backoff.

Start a local server. This one verifies the signature, which is the part you
must not skip: a webhook URL leaks eventually, through logs or a config repo or
a shared screen, and an endpoint that does not verify will then accept
fabricated events from anyone who found the URL.

```js
import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

const SECRET = process.env.YAPPY_WEBHOOK_SECRET;
const TOKEN = process.env.YAPPY_BOT_TOKEN;
const API = 'https://api.yappy.gg/v1';

function verify(raw, header) {
  const expected = createHmac('sha256', SECRET).update(raw).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(header ?? '');
  return a.length === b.length && timingSafeEqual(a, b);
}

createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    // The HMAC is over the bytes as received, before any JSON parsing.
    const raw = Buffer.concat(chunks);

    if (!verify(raw, req.headers['x-yappy-signature'])) {
      res.writeHead(401).end();
      return;
    }

    // Acknowledge first, work after. The delivery times out at five seconds,
    // and a slow handler earns itself a pointless retry.
    res.writeHead(204).end();

    const event = JSON.parse(raw.toString('utf8'));
    if (event.type === 'interaction.pressed') await onPress(event.data);
  });
}).listen(8787, () => console.log('listening on 8787'));

async function onPress({ conversationId, messageId, customId, invoker }) {
  console.log(`${invoker.userId} pressed ${customId}`);

  // Retire the prompt. A spent button that still looks pressable is a bug.
  await fetch(`${API}/conversations/${conversationId}/messages/${messageId}`, {
    method: 'PATCH',
    headers: { authorization: `Bot ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      content: customId === 'deploy:yes' ? 'Deploying.' : 'Cancelled.',
      components: [],
    }),
  });
}
```

Expose port 8787 with a tunnel of your choice, then register the URL. It must
be `https` outside of localhost, and the signing secret comes back exactly once:

```bash
curl -X PUT https://api.yappy.gg/v1/apps/<applicationId>/webhook \
  -H "Authorization: Bot yb_9c1f8a2b..." \
  -H "Content-Type: application/json" \
  -d '{ "url": "https://your-tunnel.example/yappy" }'
```

```json
{ "webhookUrl": "https://your-tunnel.example/yappy", "secret": "a1b2c3..." }
```

## 7. Post a button and press it

```bash
curl -X POST https://api.yappy.gg/v1/conversations/<conversationId>/messages \
  -H "Authorization: Bot yb_9c1f8a2b..." \
  -H "Content-Type: application/json" \
  -d '{
    "nonce": "deploy-1",
    "type": "text",
    "content": null,
    "embeds": [{ "title": "Deploy to production?", "color": "#f5a524", "fields": [] }],
    "components": [{
      "type": "row",
      "components": [
        { "type": "button", "customId": "deploy:yes", "label": "Deploy", "style": "success" },
        { "type": "button", "customId": "deploy:no",  "label": "Cancel", "style": "danger" }
      ]
    }]
  }'
```

Press it in the app. Your server logs the press and the message rewrites itself
with the buttons gone.

## 8. The one rule

Before you build anything with real consequences, internalise this:

> Authorisation is always checked against the person who invoked the action,
> never against the bot.

Your bot may hold every permission in a group. That must not let an ordinary
member borrow those powers by pressing one of its buttons. Put
`requiredPermissions` on any consequential button and the server checks the
presser's own permissions before your bot is ever told about the press. The
SDK accepts a name: `{ requiredPermissions: 'KICK_MEMBERS' }`. Put
`onlyUserId` on anything acting for one person in a shared conversation.

The interaction payload also hands you the invoker's `permissions` and
`isStaff`, so you can make your own check without a second call. Do it. The
server's checks are the platform's promise; that one is yours.

## Where to go next

- [The bot guide](BOTS.md) for embeds, charts, live cards, the full component
  object, and delivery guarantees.
- [The bot API reference](BOT_API.md) for every endpoint your token can call.
- [Permissions](PERMISSIONS.md) for the bitfield and how checks are resolved.
- [Errors and limits](ERRORS.md) for every error code and how to retry safely.
