import { asc, count, eq, yapperLore } from '@yappy/db';
import { newId, type EmbedInput } from '@yappy/shared';
import type { FastifyInstance } from 'fastify';

/**
 * Group lore: the shared list of facts a group has taught its bot.
 *
 * Three commands and one injection point. `/remember` writes, `/lore` reads,
 * `/forget` erases — all deterministic, no model involved, which is why they
 * are safe to run on any group message rather than only on mentions. The
 * payoff is in `yapperAi.ts`, where the whole list rides into the prompt every
 * time the group summons the bot: that is what turns "stored rows" into a bot
 * that appears to have been paying attention for months.
 *
 * Everything here is group-shared, not per-person. Any member can add, any
 * member can forget — the same trust model as the group's own name.
 */

const VIOLET = '#8b7cff';

/** A prompt-size budget as much as a storage one: the list is injected whole. */
export const MAX_LORE_FACTS = 100;
export const MAX_LORE_CHARS = 280;

/** How many facts ride into the model's context per summon, newest last. */
export const LORE_PROMPT_FACTS = 30;

interface LoreReply {
  content: string | null;
  embeds?: EmbedInput[];
}

/** Ordered as taught — the numbering `/forget` uses must match what `/lore` shows. */
async function factsInOrder(app: FastifyInstance, conversationId: string) {
  return app.db
    .select({
      id: yapperLore.id,
      body: yapperLore.body,
      authorId: yapperLore.authorId,
      createdAt: yapperLore.createdAt,
    })
    .from(yapperLore)
    .where(eq(yapperLore.conversationId, conversationId))
    .orderBy(asc(yapperLore.createdAt), asc(yapperLore.id))
    .limit(MAX_LORE_FACTS);
}

/**
 * Store one fact. Shared by `/remember` and by the model's `remember` output
 * (someone asked in plain words), so the cap and the length clamp cannot be
 * bypassed by phrasing the request nicely.
 */
export async function addLoreFact(
  app: FastifyInstance,
  input: { conversationId: string; authorId: string; body: string },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const body = input.body.trim().replace(/\s+/g, ' ').slice(0, MAX_LORE_CHARS);
  if (body.length < 2) {
    return { ok: false, reason: 'Give me something to remember. /remember the actual fact.' };
  }

  const [row] = await app.db
    .select({ n: count() })
    .from(yapperLore)
    .where(eq(yapperLore.conversationId, input.conversationId));
  if ((row?.n ?? 0) >= MAX_LORE_FACTS) {
    return {
      ok: false,
      reason: `This group's lore is full (${MAX_LORE_FACTS} facts). /lore to see it, /forget <number> to make room.`,
    };
  }

  await app.db.insert(yapperLore).values({
    id: newId(),
    conversationId: input.conversationId,
    authorId: input.authorId,
    body,
  });
  return { ok: true };
}

/** The lines injected into the group prompt, or null when there is no lore. */
export async function lorePromptBlock(
  app: FastifyInstance,
  conversationId: string,
): Promise<string | null> {
  const facts = await factsInOrder(app, conversationId);
  if (facts.length === 0) return null;

  const shown = facts.slice(-LORE_PROMPT_FACTS);
  return [
    "Group lore — facts this group told you to remember. Treat them as true here, weave them in when relevant, don't recite them unprompted:",
    ...shown.map((f) => `- ${f.body}`),
  ].join('\n');
}

/** Quick gate so the caller only pays the membership check for lore messages. */
export const LORE_COMMAND = /^\/(remember|lore|forget)\b/i;

/**
 * `/remember`, `/lore`, `/forget` in a group. Returns null when the message is
 * none of these, so the caller can fall through to the mention path.
 *
 * The caller gates on yapper's membership before calling (same rule as the AI
 * path): a group the bot was never added to gets silence, not a reply from a
 * bot that is not in the room.
 */
export async function handleLoreCommand(
  app: FastifyInstance,
  input: { conversationId: string; senderId: string; content: string },
): Promise<LoreReply | null> {
  const text = input.content.trim();
  const match = /^\/(remember|lore|forget)\b\s*([\s\S]*)$/i.exec(text);
  if (!match) return null;

  const verb = match[1]!.toLowerCase();
  const rest = (match[2] ?? '').trim();

  if (verb === 'remember') {
    const added = await addLoreFact(app, {
      conversationId: input.conversationId,
      authorId: input.senderId,
      body: rest,
    });
    if (!added.ok) return { content: added.reason };
    return { content: `Noted. That's lore now. 📖 /lore to see everything I know.` };
  }

  if (verb === 'forget') {
    const facts = await factsInOrder(app, input.conversationId);
    const n = Number.parseInt(rest, 10);
    if (!Number.isFinite(n) || n < 1 || n > facts.length) {
      return {
        content:
          facts.length === 0
            ? 'There is no lore to forget yet.'
            : `Which one? /lore shows the numbers, then /forget <number>. There are ${facts.length}.`,
      };
    }
    const target = facts[n - 1]!;
    await app.db.delete(yapperLore).where(eq(yapperLore.id, target.id));
    return { content: `Forgotten: "${clip(target.body, 80)}"` };
  }

  // /lore — the list, numbered so /forget has an address for each fact.
  const facts = await factsInOrder(app, input.conversationId);
  if (facts.length === 0) {
    return {
      content: null,
      embeds: [
        {
          title: '📖 Group lore',
          description:
            'Nothing yet. Teach me with /remember — inside jokes, running bits, who owes who what. I bring it up when it fits.',
          color: VIOLET,
          fields: [],
        },
      ],
    };
  }

  // One description block rather than a field per fact: embeds cap their
  // fields well below the lore cap, and a numbered list reads better anyway.
  const lines = facts.map((f, i) => `${i + 1}. ${f.body}`);
  return {
    content: null,
    embeds: [
      {
        title: '📖 Group lore',
        description: clip(lines.join('\n'), 3_900),
        color: VIOLET,
        fields: [],
        footer: {
          text: `${facts.length}/${MAX_LORE_FACTS} · /remember adds · /forget <number> removes`,
        },
      },
    ],
  };
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
