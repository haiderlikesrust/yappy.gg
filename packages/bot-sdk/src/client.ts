import { connectGateway, type Connection, type ConnectOptions } from './gateway.js';
import { startLive } from './live.js';
import type { IncomingMessage, InteractionResponse, LiveCard, LiveOptions, SendMessageInput } from './types.js';

/** A process holding twenty-five live cards has lost the plot. Oldest stops first. */
const MAX_LIVES = 25;

export interface YappyBotOptions {
  /** The bot token from the developer portal. Sent as `Authorization: Bot …`. */
  token: string;
  /** Defaults to production. Point at your dev API when testing. */
  baseUrl?: string;
  /**
   * Per-request timeout. Kept short by default because a bot that hangs on the
   * API is a bot that stops answering its webhook, and the platform gives you
   * five seconds to respond before it counts the delivery failed.
   */
  timeoutMs?: number;
}

export class YappyApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'YappyApiError';
  }
}

/**
 * A bot's handle on the API.
 *
 * Thin on purpose. Everything here is one HTTP call you could have made
 * yourself; what the wrapper buys you is the auth header, the error shape, and
 * not having to rediscover that `nonce` is what makes a retry safe.
 */
export class YappyBot {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly lives = new Map<string, LiveCard>();

  constructor(options: YappyBotOptions) {
    if (!options.token) throw new Error('A bot token is required');
    this.token = options.token;
    this.baseUrl = (options.baseUrl ?? 'https://api.yappy.gg/v1').replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  /**
   * The token, for the gateway's IDENTIFY frame.
   *
   * Readonly and deliberately not named `token`, so that reaching for it looks
   * like what it is. Nothing else in the SDK needs it.
   */
  get credential(): string {
    return this.token;
  }

  /**
   * Hold a socket open and receive events, rather than being called at a URL.
   *
   * The reason to prefer this over a webhook: no public address, so the bot
   * runs anywhere with an outbound connection. See `connectGateway`.
   *
   * ```ts
   * bot.connect({
   *   url: 'wss://ws.yappy.gg',
   *   onMessage: async ({ conversationId, message }) => { … },
   * });
   * ```
   */
  connect(options: ConnectOptions = {}): Connection {
    return connectGateway(this, options);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bot ${this.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const text = await res.text();
    const parsed: unknown = text ? JSON.parse(text) : {};

    if (!res.ok) {
      const err = parsed as { error?: { code?: string; message?: string } };
      throw new YappyApiError(
        res.status,
        err.error?.code ?? 'unknown',
        err.error?.message ?? `Request failed with ${res.status}`,
      );
    }

    return parsed as T;
  }

  /** Who am I, and which application am I. */
  async me(): Promise<unknown> {
    // `/apps`, not `/bots` — the routes are mounted under the application, and
    // the name in the source file is not the name on the wire.
    return this.request('GET', '/apps/me');
  }

  /**
   * Post into a conversation.
   *
   * Pass a `nonce` if this send might be retried — a duplicate nonce resolves
   * to the message that already exists rather than posting a second one. For a
   * bot answering a webhook that is worth doing every time, because the
   * platform retries a delivery your process may have already handled.
   */
  async send(conversationId: string, input: SendMessageInput): Promise<{ message: IncomingMessage }> {
    return this.request('POST', `/conversations/${conversationId}/messages`, {
      type: 'text',
      ...input,
    });
  }

  /** Post as a reply to a specific message. */
  async reply(
    conversationId: string,
    replyToId: string,
    input: Omit<SendMessageInput, 'replyToId'>,
  ): Promise<{ message: IncomingMessage }> {
    return this.send(conversationId, { ...input, replyToId });
  }

  /**
   * Answer a button press that arrived over the socket.
   *
   * A webhook bot answers in the body of the delivery. A socket bot has no
   * response to write into, so it posts the same `InteractionResponse` here
   * and the server applies it — `update` rewrites the card that was pressed,
   * `reply` posts a new message.
   *
   * `connect()` calls this for you with whatever your `onInteraction` returns.
   * It is public because a bot that does slow work — a lookup, a build, a
   * payment — should acknowledge the press immediately and call this when the
   * answer actually exists.
   */
  async respondToInteraction(
    conversationId: string,
    messageId: string,
    response: InteractionResponse,
  ): Promise<unknown> {
    return this.request(
      'POST',
      `/conversations/${conversationId}/messages/${messageId}/callback`,
      response,
    );
  }

  /** Edit one of your own messages. */
  async edit(
    conversationId: string,
    messageId: string,
    input: Pick<SendMessageInput, 'content' | 'embeds' | 'components'>,
  ): Promise<unknown> {
    return this.request('PATCH', `/conversations/${conversationId}/messages/${messageId}`, input);
  }

  async react(conversationId: string, messageId: string, emoji: string): Promise<unknown> {
    return this.request(
      'PUT',
      `/conversations/${conversationId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`,
    );
  }

  /**
   * Post a card and rewrite it on a timer.
   *
   * The first `render()` is the post; every tick after that is an `edit` of
   * the same message. Edits never push a phone. The first post is silent
   * unless you set `silent: false`.
   *
   * This is a loop in *this* process. A serverless webhook with nothing
   * kept alive cannot use it — use a Refresh button there, the way the
   * scanner did before this existed. A process that exits stops the
   * rewriting; the card stays.
   *
   * ```ts
   * const card = await bot.live(conversationId, {
   *   every: '30s',
   *   until: '10m',
   *   silent: false,
   *   replyToId: message.id,
   *   render: async () => scanCard(await fetchCoin(mint)),
   * });
   * // card.stop() when you are done early
   * ```
   *
   * At most 25 lives per process. A 26th stops the oldest, because a bot
   * that wants fifty ticking cards has a different problem.
   */
  async live(conversationId: string, options: LiveOptions): Promise<LiveCard> {
    let key = '';
    const card = await startLive(this, conversationId, options, () => {
      if (key) this.lives.delete(key);
    });
    key = `${conversationId}:${card.messageId}`;

    this.lives.get(key)?.stop();
    if (this.lives.size >= MAX_LIVES) {
      const oldest = this.lives.keys().next().value;
      if (oldest) this.lives.get(oldest)?.stop();
    }
    this.lives.set(key, card);
    return card;
  }

  /** Stop every live card this process is rewriting. */
  stopLives(): void {
    const cards = [...this.lives.values()];
    this.lives.clear();
    for (const card of cards) card.stop();
  }
}
