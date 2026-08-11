import type { SendMessageInput, IncomingMessage } from './types.js';

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

  constructor(options: YappyBotOptions) {
    if (!options.token) throw new Error('A bot token is required');
    this.token = options.token;
    this.baseUrl = (options.baseUrl ?? 'https://api.yappy.gg/v1').replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 10_000;
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
    return this.request('GET', '/bots/me');
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
}
