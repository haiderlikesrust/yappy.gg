import { YappyBot } from '@yappydotgg/bot-sdk';
import { declareCommands, whoAmI } from './api.js';
import { COMMANDS, DECLARATIONS } from './commands/index.js';
import { Reminders, type ReminderState } from './reminders.js';
import { Store } from './store.js';

/**
 * A utility bot for yappy groups.
 *
 *   /remind 20m take the pizza out
 *   /reminders
 *   /timer 10m standup
 *   /time 3pm PT
 *   /chart bar mon=3 tue=5 wed=9
 *   /pick pizza | sushi | tacos
 *
 * Every one of those is answered with what the group already has — no API
 * keys, no accounts, nothing to sign up for. The bot holds a socket, so it
 * runs on a laptop behind NAT with a token and nothing else.
 *
 *   YAPPY_TOKEN          the bot token, shown once when you create the bot
 *   YAPPY_API_URL        optional, defaults to production
 *   YAPPY_GATEWAY_URL    optional, defaults to production
 *   UTILITY_DATA         optional, where reminders are kept
 *   UTILITY_TZ           optional, the zone "9pm" means. Defaults to UTC.
 */

const token = process.env.YAPPY_TOKEN;
if (!token) {
  console.error('YAPPY_TOKEN is not set. Copy .env.example to .env and put your bot token in it.');
  process.exit(1);
}

const apiUrl = (process.env.YAPPY_API_URL ?? 'https://api.yappy.gg/v1').replace(/\/+$/, '');
const zone = process.env.UTILITY_TZ ?? 'UTC';
const dataPath = process.env.UTILITY_DATA ?? './data/state.json';

const bot = new YappyBot({ token, baseUrl: apiUrl });

const me = await whoAmI(apiUrl, token);
console.log(`[boot] @${me.username} (${me.name})`);

/**
 * Declared once at boot, not on every message.
 *
 * The composer needs an answer on the first character after `/`, so it asks the
 * server rather than the bot. A bot that is asleep must not make typing feel
 * broken — which is exactly what happens if the command list only exists in
 * this process.
 */
try {
  await declareCommands(apiUrl, token, me.applicationId, DECLARATIONS);
  console.log(`[boot] declared ${DECLARATIONS.length} commands`);
} catch (err) {
  // Worth continuing without: the bot still answers, the composer just does
  // not offer autocomplete for it.
  console.error('[boot] could not declare commands:', err);
}

const store = await Store.open<ReminderState>(dataPath, { reminders: [] });
const reminders = new Reminders(store, bot, zone);
await reminders.resume();

const connection = bot.connect({
  url: process.env.YAPPY_GATEWAY_URL,

  onReady: () => console.log('[gateway] ready'),

  onMessage: async ({ conversationId, message }) => {
    // Never answer a machine, including this one. Two bots that answer each
    // other are a loop that ends in a rate limit.
    if (message.sender?.isBot) return;
    const content = message.content?.trim();
    if (!content?.startsWith('/')) return;

    const [word = '', ...rest] = content.slice(1).split(/\s+/);
    const command = COMMANDS.get(word.toLowerCase());
    // Unknown slash words belong to somebody else's bot, or to nobody.
    if (!command) return;

    await command.run({
      bot,
      conversationId,
      message,
      args: rest.join(' ').trim(),
      reminders,
      zone,
    });
  },

  onInteraction: async ({ customId, invoker }) => {
    if (!customId.startsWith('rem:cancel:')) return { kind: 'ack' };

    const cancelled = await reminders.cancel(customId.slice('rem:cancel:'.length), invoker.userId);
    if (!cancelled) {
      // Already fired, already cancelled, or not theirs. All three are the same
      // answer, and none of them is an error worth a new message.
      return { kind: 'ack' };
    }

    // Retire the card rather than leaving a button that no longer does
    // anything. `update` rewrites the message that was pressed.
    return { kind: 'update', content: `Cancelled: ${cancelled.text}`, embeds: [], components: [] };
  },

  onError: (err) => console.error('[bot]', err),

  onDisconnect: ({ code, reason, willRetry }) =>
    console.warn(`[gateway] closed ${code} ${reason}${willRetry ? ', retrying' : ''}`),
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n[shutdown] ${signal}`);
    bot.stopLives();
    connection.close();
    process.exit(0);
  });
}
