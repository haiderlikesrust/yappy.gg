/**
 * The yappy bot SDK.
 *
 * A bot is three things: a token to call the API with, a webhook that hears
 * about the world, and cards it posts back. This package covers all three and
 * deliberately nothing else.
 *
 * ```ts
 * import { YappyBot, createHandler, EmbedBuilder, row, button } from '@yappy/bot-sdk';
 *
 * const bot = new YappyBot({ token: process.env.YAPPY_TOKEN! });
 *
 * const handle = createHandler({
 *   secret: process.env.YAPPY_WEBHOOK_SECRET!,
 *   async onMessage({ conversationId, message }) {
 *     if (!message.content?.includes('hello')) return;
 *     await bot.reply(conversationId, message.id, {
 *       embeds: [new EmbedBuilder().title('Hi').color('#8b7cff').build()],
 *       components: [row(button('wave', 'Wave back', 'primary'))],
 *     });
 *   },
 * });
 * ```
 *
 * Then hand `handle` your framework's raw body and the `x-yappy-signature`
 * header. Raw, not re-encoded: the signature is over the exact bytes sent.
 */

export { YappyBot, YappyApiError, type YappyBotOptions } from './client.js';
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
