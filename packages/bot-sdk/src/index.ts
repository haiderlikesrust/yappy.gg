/**
 * The yappy bot SDK.
 *
 * A bot is three things: a token to call the API with, a connection that hears
 * about the world, and cards it posts back. This package covers all three and
 * deliberately nothing else.
 *
 * ```ts
 * import { YappyBot, EmbedBuilder, row, button } from '@yappy/bot-sdk';
 *
 * const bot = new YappyBot({ token: process.env.YAPPY_TOKEN! });
 *
 * bot.connect({
 *   async onMessage({ conversationId, message }) {
 *     if (!message.content?.includes('hello')) return;
 *     await bot.reply(conversationId, message.id, {
 *       embeds: [new EmbedBuilder().title('Hi').color('#8b7cff').build()],
 *       components: [row(button('wave', 'Wave back', 'primary'))],
 *     });
 *   },
 *   async onInteraction({ customId }) {
 *     return { kind: 'update', content: `pressed ${customId}` };
 *   },
 * });
 * ```
 *
 * That is the whole program. The bot dials out, so it needs no public address,
 * no HTTPS certificate and no tunnel — it runs on a laptop.
 *
 * **Webhooks are the other way to do this**, and the right one when your bot is
 * a serverless function with no process to keep alive. Use `createHandler`,
 * pass it your framework's raw body and the `x-yappy-signature` header — raw,
 * not re-encoded, because the signature is over the exact bytes sent. Do not
 * use both at once: each delivers everything, so a bot with a socket *and* a
 * webhook handles every event twice.
 */

export { YappyBot, YappyApiError, type YappyBotOptions } from './client.js';
export { connectGateway, type Connection, type ConnectOptions } from './gateway.js';
export { createHandler, type HandlerOptions, type HandlerResult } from './handler.js';
export { verifySignature } from './verify.js';
export { EmbedBuilder, button, row } from './embed.js';
export type {
  Button,
  ButtonStyle,
  ComponentRow,
  Embed,
  EmbedField,
  IncomingMessage,
  InteractionPressedEvent,
  InteractionResponse,
  MessageCreatedEvent,
  MessageSender,
  SendMessageInput,
  WebhookEvent,
} from './types.js';
