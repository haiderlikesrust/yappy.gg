import {
  and,
  conversationMembers,
  conversations,
  desc,
  eq,
  isNull,
  messages,
  users,
} from '@yappy/db';
import type { FastifyInstance } from 'fastify';
import { env } from '../env.js';

/**
 * @yapper in groups.
 *
 * yapper's DM is a command surface; in a group it is a member you can ask
 * things. The contract is deliberately narrow: it answers **only when
 * mentioned**, and only in conversations somebody with permission chose to add
 * it to. Nothing ambient — a message that does not name the bot is never read
 * by a model, never leaves the server, and costs nothing.
 *
 * That line is what the privacy policy promises, so it is enforced here at the
 * entry point rather than trusted to prompt wording: no mention, no model call.
 */

/** How much of the room the model gets to see. Enough to follow a
 *  conversation, small enough that the marginal cost per answer stays flat. */
const CONTEXT_MESSAGES = 25;

/** Replies are chat messages, not essays. The prompt asks for short; this is
 *  the backstop for when the model does not listen. */
const REPLY_MAX_CHARS = 2_000;

const OPENAI_TIMEOUT_MS = 30_000;

/**
 * Membership, cached with a TTL — unlike DM-ness this answer *changes* (the
 * group can remove the bot), so entries expire rather than live forever. A
 * minute of staleness at worst means one answered mention right after a
 * removal, which is harmless; checking the database on every group message in
 * the instance would not be.
 */
const memberCache = new Map<string, { isMember: boolean; expires: number }>();
const MEMBER_CACHE_TTL_MS = 60_000;
const MEMBER_CACHE_MAX = 5_000;

async function isYapperMember(
  app: FastifyInstance,
  conversationId: string,
  botId: string,
): Promise<boolean> {
  const cached = memberCache.get(conversationId);
  if (cached && cached.expires > Date.now()) return cached.isMember;

  const [row] = await app.db
    .select({ userId: conversationMembers.userId })
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.userId, botId),
        isNull(conversationMembers.leftAt),
      ),
    )
    .limit(1);

  if (memberCache.size >= MEMBER_CACHE_MAX) {
    const first = memberCache.keys().next().value;
    if (first) memberCache.delete(first);
  }
  memberCache.set(conversationId, { isMember: Boolean(row), expires: Date.now() + MEMBER_CACHE_TTL_MS });
  return Boolean(row);
}

/** A removal should take effect immediately, not after the TTL. */
export function invalidateYapperMembership(conversationId: string): void {
  memberCache.delete(conversationId);
}

/**
 * Was yapper mentioned? The entity is the real signal — it is what the
 * composer writes when someone picks the bot from the mention sheet. The text
 * fallback covers a mention typed by hand without the picker, which the
 * entity list would not carry.
 */
export function mentionsYapper(
  botId: string,
  content: string,
  entities?: Array<{ type: string; userId?: string }>,
): boolean {
  if (entities?.some((e) => e.type === 'mention' && e.userId === botId)) return true;
  return /@yapper\b/i.test(content);
}

/**
 * Answer a mention in a group, or explain why not. Returns null when this
 * message is simply not for the bot (not a mention, not a member, over the
 * rate limit) — silence is correct there, an error reply is not.
 */
export async function yapperGroupAiReply(
  app: FastifyInstance,
  input: {
    conversationId: string;
    senderId: string;
    botId: string;
    content: string;
    entities?: Array<{ type: string; userId?: string }>;
  },
): Promise<string | null> {
  if (!mentionsYapper(input.botId, input.content, input.entities)) return null;
  if (!(await isYapperMember(app, input.conversationId, input.botId))) return null;

  // Per-conversation budget. Silently dropped when exhausted: the group is
  // already noisy at that point, and a bot posting "slow down" makes it noisier.
  try {
    await app.limiter.consume(`conv:${input.conversationId}`, 'yapper.ai');
  } catch {
    return null;
  }

  if (!env.OPENAI_API_KEY) {
    return 'I can hear you, but my AI is not set up on this server yet — the operator needs to add an OpenAI key.';
  }

  try {
    const [conversation] = await app.db
      .select({ title: conversations.title })
      .from(conversations)
      .where(eq(conversations.id, input.conversationId))
      .limit(1);

    // The triggering message is already committed, so it arrives as the last
    // line of the transcript — the model sees the question in its context.
    const recent = await app.db
      .select({
        content: messages.content,
        senderId: messages.senderId,
        name: users.displayName,
        username: users.username,
        isBot: users.isBot,
      })
      .from(messages)
      .innerJoin(users, eq(users.id, messages.senderId))
      .where(
        and(
          eq(messages.conversationId, input.conversationId),
          eq(messages.type, 'text'),
          isNull(messages.deletedAt),
        ),
      )
      .orderBy(desc(messages.seq))
      .limit(CONTEXT_MESSAGES);

    const transcript = recent
      .reverse()
      .filter((m) => m.content?.trim())
      .map((m) => `${m.isBot ? 'yapper' : (m.name ?? m.username ?? 'someone')}: ${m.content}`)
      .join('\n');

    const system = [
      'You are yapper, the resident bot in a group chat on yappy, a group-first messenger.',
      'You were added by the group and you answer when someone mentions @yapper.',
      'Voice: a sharp, friendly group member. Concise — a chat bubble, not an essay. Under 100 words unless the question genuinely needs more.',
      'Plain text only: no markdown headings, no bullet lists unless listing is the actual answer, emoji sparingly.',
      'Ground answers in the conversation when it is referenced; never invent things group members said.',
      'You cannot take actions in the app (no kicking, pinning, creating anything) — if asked, say so in one line.',
      'If a request is unsafe or way outside a group chat\'s lane, decline briefly without lecturing.',
    ].join('\n');

    const user = [
      conversation?.title ? `Group: ${conversation.title}` : null,
      '',
      'Recent messages, oldest first:',
      transcript,
      '',
      'The last message mentions you. Reply to it as yapper.',
    ]
      .filter((line) => line !== null)
      .join('\n');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.OPENAI_API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: env.OPENAI_MODEL,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          max_completion_tokens: 1_000,
          // Chat latency matters more than depth here; only the gpt-5 family
          // understands the knob, so it is sent conditionally.
          ...(env.OPENAI_MODEL.startsWith('gpt-5') ? { reasoning_effort: 'minimal' } : {}),
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      app.log.warn({ status: response.status, detail: detail.slice(0, 500) }, 'yapper AI call failed');
      return 'My brain glitched mid-thought — ask me again in a minute. 🧠';
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    const text = payload.choices?.[0]?.message?.content?.trim();
    if (!text) return 'I had nothing — ask me again? 🫠';
    return text.length > REPLY_MAX_CHARS ? `${text.slice(0, REPLY_MAX_CHARS - 1)}…` : text;
  } catch (err) {
    app.log.error({ err }, 'yapper AI reply failed');
    return 'My brain glitched mid-thought — ask me again in a minute. 🧠';
  }
}
