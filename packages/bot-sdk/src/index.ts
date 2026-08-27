/**
 * The yappy bot SDK.
 *
 * A bot is three things: a token to call the API with, a connection that hears
 * about the world, and cards it posts back. This package covers all three and
 * deliberately nothing else.
 *
 * ```ts
 * import { YappyBot, EmbedBuilder, row, button, perms } from '@yappydotgg/bot-sdk';
 *
 * const bot = new YappyBot({ token: process.env.YAPPY_TOKEN! });
 *
 * bot.connect({
 *   async onMessage({ conversationId, message }) {
 *     if (!message.content?.includes('hello')) return;
 *     await bot.reply(conversationId, message.id, {
 *       embeds: [
 *         new EmbedBuilder()
 *           .title('Hi')
 *           .color('#8b7cff')
 *           .chart('bar', [
 *             { label: 'Now', value: 12 },
 *             { label: 'Then', value: 4 },
 *           ])
 *           .build(),
 *       ],
 *       components: [
 *         row(button('wave', 'Wave back', 'primary')),
 *         row(button('kick', 'Kick', 'danger', { requiredPermissions: 'KICK_MEMBERS' })),
 *       ],
 *     });
 *   },
 *   async onInteraction({ customId, invoker }) {
 *     if (customId === 'kick' && !perms.has(invoker.permissions, 'KICK_MEMBERS')) {
 *       return { kind: 'ack' };
 *     }
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
 *
 * **`live()` keeps a card fresh** by rewriting it on a timer. It needs a
 * process, so it belongs with the socket, not with a webhook.
 */

export { YappyBot, YappyApiError, type YappyBotOptions } from './client.js';
export { connectGateway, type Connection, type ConnectOptions } from './gateway.js';
export { createHandler, type HandlerOptions, type HandlerResult } from './handler.js';
export { verifySignature } from './verify.js';
export { newNonce } from './nonce.js';
export { EmbedBuilder, button, row, type ButtonOptions } from './embed.js';
export { Permission, perms, type PermissionInput, type PermissionName } from './perms.js';
export type {
  Button,
  ButtonStyle,
  ChartKind,
  ChartPoint,
  ComponentRow,
  Embed,
  EmbedChart,
  EmbedField,
  IncomingMessage,
  InteractionPressedEvent,
  InteractionResponse,
  LiveCard,
  LiveDuration,
  LiveOptions,
  MessageCreatedEvent,
  MessageEntity,
  MessageSender,
  RenderedCard,
  SendMessageInput,
  WebhookEvent,
} from './types.js';
