import { startFeed } from './feed.js';
import { connectGateway, type Connection, type ConnectOptions } from './gateway.js';
import { startLive } from './live.js';
import { newNonce } from './nonce.js';
import type {
  BotCard,
  Feed,
  FeedOptions,
  IncomingMessage,
  InteractionResponse,
  LiveCard,
  LiveOptions,
  SendMessageInput,
} from './types.js';

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
  /** Keyed by conversation and card name, which is what a feed owns. */
  private readonly feeds = new Map<string, Feed>();

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
   * A `nonce` is generated when you do not pass one. The server requires the
   * field — a duplicate nonce resolves to the message that already exists
   * instead of posting a second one — and a send that answered `400 validation
   * failed` because the caller had not thought about idempotency yet was a
   * miserable first five minutes with this SDK.
   *
   * Pass your own when a retry of *your* logic must not post twice: a
   * redelivered webhook, or a restarted process picking up where it left off.
   * Derive it from something stable — the message you are answering, say —
   * rather than from the clock.
   */
  async send(conversationId: string, input: SendMessageInput): Promise<{ message: IncomingMessage }> {
    return this.request('POST', `/conversations/${conversationId}/messages`, {
      type: 'text',
      ...input,
      nonce: input.nonce ?? newNonce(),
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
    input: Pick<SendMessageInput, 'content' | 'entities' | 'embeds' | 'components'>,
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
   * Open a channel in a space.
   *
   * The interesting arguments are `isPrivate` and `members`, which together
   * are the whole of a support ticket: a channel ordinary members cannot see,
   * with the one person who opened it let in. Both are applied inside the
   * creating transaction, so there is no moment where the room exists and is
   * readable by the whole space.
   *
   * Two things worth knowing before you build a ticket flow on this.
   *
   * A private channel is private *from members*, not from staff. The floor is
   * expressed by zeroing the base, and the moderator/admin ladder is ORed on
   * top of the base — so moderators, administrators and the owner all still
   * see it. For a support ticket that is the point. If you need a room even
   * moderators cannot read, a zeroed base is not the tool.
   *
   * And resist a role per ticket. `LIMITS.rolesPerConversation` is 50: the
   * design reads beautifully and then ticket 51 fails and the space is stuck
   * with fifty dead roles. `members` has no such ceiling and leaves nothing
   * behind when the ticket closes.
   *
   * Your bot needs MANAGE_CONVERSATION to create a channel, and MANAGE_ROLES
   * as well for `isPrivate` or `members` — deciding who is in a room is a
   * permission write, and it is gated like one.
   */
  async createChannel(
    spaceId: string,
    input: {
      title: string;
      description?: string | null;
      isPrivate?: boolean;
      /** Space members admitted to this channel. See the note above. */
      members?: string[];
      isVoice?: boolean;
      isBoard?: boolean;
      isForum?: boolean;
      isAnnouncement?: boolean;
      position?: number;
      /**
       * File it under a category as it is created.
       *
       * This is the reason a bot cares about categories at all: a support bot
       * that opens one channel per ticket turns a sidebar into a wall, and
       * filing them as they are made is the difference between a space people
       * can read and one they scroll past. Omit it and the channel sits loose
       * above the dividers, which is right for the handful that belong there.
       */
      categoryId?: string | null;
    },
  ): Promise<{ channel: { id: string; title: string } }> {
    return this.request('POST', `/conversations/${spaceId}/channels`, input);
  }

  /**
   * The channels of a space, as this bot can see them, and the categories
   * they are filed under.
   *
   * The categories come back on this call rather than one of their own,
   * because a channel list and the dividers in it are two halves of one
   * screen and fetching them apart leaves a window where a client holds
   * channels filed under categories it has not seen yet.
   *
   * You are only told about categories you can see a channel in — a name is
   * a leak too — unless your bot holds MANAGE_CONVERSATION, which also gets
   * you the empty ones.
   */
  async channels(spaceId: string): Promise<{
    channels: Array<{ id: string; title: string | null; categoryId: string | null }>;
    categories: Array<{ id: string; name: string; position: number }>;
  }> {
    return this.request('GET', `/conversations/${spaceId}/channels`);
  }

  /**
   * Make a divider in a space's channel list.
   *
   * A category is a label with an order and nothing else — no members, no
   * messages, no permissions of its own. Filing a channel under one changes
   * where it is drawn and nothing about who may see it, which is what makes
   * it safe for a bot to do unprompted.
   *
   * Needs MANAGE_CONVERSATION, the same permission as creating the channels
   * it will hold. Idempotency is yours to arrange: this always makes a new
   * one, so look through `channels()` for the name first if you mean
   * "ensure".
   */
  async createCategory(
    spaceId: string,
    input: { name: string; position?: number },
  ): Promise<{ category: { id: string; name: string; position: number } }> {
    return this.request('POST', `/conversations/${spaceId}/categories`, input);
  }

  async updateCategory(
    spaceId: string,
    categoryId: string,
    input: { name?: string; position?: number },
  ): Promise<{ category: { id: string; name: string; position: number } }> {
    return this.request('PATCH', `/conversations/${spaceId}/categories/${categoryId}`, input);
  }

  /**
   * Remove a divider. The channels under it survive and go loose — deleting
   * a category is never a way to delete channels.
   */
  async deleteCategory(spaceId: string, categoryId: string): Promise<{ deleted: boolean }> {
    return this.request('DELETE', `/conversations/${spaceId}/categories/${categoryId}`);
  }

  /**
   * The category named `name`, made if it is not there yet.
   *
   * What a bot filing its own channels actually wants, and the thing every
   * bot would otherwise write for itself — badly, because the obvious
   * version creates a second "Tickets" on the first restart.
   */
  async ensureCategory(spaceId: string, name: string): Promise<string> {
    const { categories } = await this.channels(spaceId);
    const existing = categories.find((c) => c.name === name);
    if (existing) return existing.id;
    const made = await this.createCategory(spaceId, { name });
    return made.category.id;
  }

  /**
   * One person, by id.
   *
   * An interaction tells you who pressed but not what they are called, and
   * naming a ticket channel after a uuid helps nobody.
   */
  async user(userId: string): Promise<{
    user: { id: string; username: string | null; displayName: string | null };
  }> {
    return this.request('GET', `/users/${userId}`);
  }

  /**
   * Create a named role in a space.
   *
   * For standing groups — Moderators, Premium, Founding Member — not for
   * per-ticket access; see `createChannel` for why.
   */
  async createRole(
    spaceId: string,
    input: { name: string; permissions?: string; color?: string | null; isMentionable?: boolean },
  ): Promise<unknown> {
    return this.request('POST', `/conversations/${spaceId}/roles`, input);
  }

  /**
   * What one role may do in one channel.
   *
   * `allow` and `deny` are decimal strings, and they compose across every role
   * a member holds: denies apply first, then allows, so one role granting
   * beats another withholding. You cannot put a bit into `allow` that your own
   * bot does not hold.
   */
  async setChannelOverwrite(
    channelId: string,
    roleId: string,
    input: { allow: string; deny: string },
  ): Promise<unknown> {
    return this.request('PUT', `/conversations/${channelId}/permissions/${roleId}`, input);
  }

  /** Give a person a named role, or take it away. */
  async setMemberRoles(spaceId: string, userId: string, roleIds: string[]): Promise<unknown> {
    return this.request('PUT', `/conversations/${spaceId}/members/${userId}/roles`, { roleIds });
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

  /**
   * A card on a board, addressed by a name you choose.
   *
   * The difference from [live] is where the memory lives. `live` is a loop in
   * this process holding a message id: restart, redeploy, or run as a cron job
   * and the id is gone, so the next run posts a *second* card and the first one
   * sits there forever going stale. A named card has no id to lose — the
   * server knows which message `sol-price` means, and the first call creates it
   * while every call after edits the same one.
   *
   * ```ts
   * // Survives a restart, a deploy, and a cold lambda.
   * await bot.card(channelId, 'sol-price').set({
   *   embeds: [{ title: 'SOL', description: `${price}`, footer: 'updated just now' }],
   * });
   * ```
   *
   * The first post can ring phones if you insist. The rewrites never can —
   * they are edits, and edits do not push. That is what makes a card you
   * refresh every ten seconds something other than an attack on the room.
   *
   * Names are yours alone: two bots on one board can both own a `price`.
   */
  card(conversationId: string, key: string): BotCard {
    const path = `/conversations/${conversationId}/cards/${encodeURIComponent(key)}`;
    return {
      conversationId,
      key,
      set: (input) => this.request('PUT', path, input),
      remove: () => this.request('DELETE', path),
    };
  }

  /**
   * Keep a named card current, on a timer, for as long as this runs.
   *
   * This is the API-fed board: a channel whose contents are a program
   * rather than a person. One card per thing worth watching, each rewritten
   * in place, so the channel is a dashboard people read instead of a
   * timeline they scroll.
   *
   * ```ts
   * await bot.feed(channelId, 'sol-price', {
   *   every: '10s',
   *   render: async () => {
   *     const price = await fetchSolPrice();
   *     return {
   *       content: `**SOL** — $${price.usd}`,
   *     };
   *   },
   *   onError: (err) => console.error(err),
   * });
   * ```
   *
   * The difference from [live] is where the memory lives, and it decides
   * everything else. `live` holds a message id in this process: restart it
   * and the id is gone, so the next run posts a second card beside the
   * first, which then sits there forever going stale — and because that is
   * unsurvivable, `live` also caps itself at 24 hours. A feed holds a
   * *name*. There is nothing to lose across a restart, a redeploy, or a
   * second replica, so there is no reason for it to ever stop.
   *
   * The first write is awaited and its failure is yours — a bad token or a
   * channel the bot cannot post in should fail at the line that started the
   * feed. After that the loop keeps itself alive: a `render()` that throws
   * skips a tick and backs off, and only `403`/`404` (the channel is gone,
   * or the bot lost its permission) stops it.
   *
   * Starting a feed on a name this process is already publishing replaces
   * the old one. Two loops writing one card is a bug, not a configuration.
   */
  async feed(conversationId: string, key: string, options: FeedOptions): Promise<Feed> {
    const id = `${conversationId}:${key}`;
    this.feeds.get(id)?.stop();
    const feed = await startFeed(this, conversationId, key, options, () => {
      // Only if it is still ours: a replacement has already taken the slot.
      if (this.feeds.get(id) === feed) this.feeds.delete(id);
    });
    this.feeds.set(id, feed);
    return feed;
  }

  /** Stop every live card this process is rewriting. */
  stopLives(): void {
    const cards = [...this.lives.values()];
    this.lives.clear();
    for (const card of cards) card.stop();
  }

  /**
   * Stop every feed this process is publishing. The cards stay on the
   * board with their last value.
   *
   * Worth calling on `SIGTERM`: a feed holds a referenced timer, which is
   * what keeps a feed-only program alive, and therefore also what stops it
   * exiting when you ask it to.
   */
  stopFeeds(): void {
    const feeds = [...this.feeds.values()];
    this.feeds.clear();
    for (const feed of feeds) feed.stop();
  }
}
