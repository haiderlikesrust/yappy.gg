import { and, applications, eq, isNull, messages, users } from '@yappy/db';
import {
  conflict,
  forbidden,
  newId,
  notFound,
  type InteractionResponse,
  type MessageButton,
  type MessageComponentRow,
} from '@yappy/shared';
import type { FastifyInstance } from 'fastify';
import { requireMember, requirePermission } from './access.js';
import { handleYapperInteraction } from './yapper.js';
import { sendInteractionToBot } from './webhooks.js';

/**
 * Pressing a button.
 *
 * The contract is deliberately the same shape for a first-party bot running in
 * this process and a third-party one reached over a webhook: press → the bot
 * returns an `InteractionResponse` → we apply it. Only the transport differs,
 * so the interesting behaviour (who may press, what a press is allowed to do,
 * what happens to a spent prompt) is written once, here, rather than once per
 * kind of bot.
 *
 * A `customId` is not a secret and confers nothing. Authorisation is
 * membership of the conversation plus, where the bot set it, `onlyUserId`.
 */

function findButton(rows: unknown[], customId: string): MessageButton | null {
  for (const row of rows as MessageComponentRow[]) {
    for (const component of row?.components ?? []) {
      if (component?.customId === customId) return component;
    }
  }
  return null;
}

/** Grey out every button on a message. What a spent prompt should become. */
export function disableAll(rows: unknown[]): unknown[] {
  return (rows as MessageComponentRow[]).map((row) => ({
    ...row,
    components: row.components.map((c) => ({ ...c, disabled: true })),
  }));
}

export async function pressButton(
  app: FastifyInstance,
  input: { actorId: string; conversationId: string; messageId: string; customId: string },
): Promise<unknown> {
  const [message] = await app.db
    .select()
    .from(messages)
    .where(eq(messages.id, input.messageId))
    .limit(1);

  if (!message || message.conversationId !== input.conversationId) throw notFound('Message');
  if (message.deletedAt) throw notFound('Message');

  // Membership first: everything below leaks something about the message.
  await requireMember(app.db, input.conversationId, input.actorId);

  const button = findButton((message.components as unknown[]) ?? [], input.customId);
  if (!button) throw notFound('Button');

  // A press on a retired prompt is the common case, not an attack: two
  // devices showing the same card, and the second one is a second late.
  if (button.disabled) throw conflict('That button has already been used');

  if (button.onlyUserId && button.onlyUserId !== input.actorId) {
    throw forbidden('That button is not for you');
  }

  // The Mee6 problem, enforced at the only place it can be: a moderation
  // bot's "Ban" button must not work for whoever happens to press it. The
  // check is against the PRESSER's authority — the bot's own permissions are
  // irrelevant here, because the bot is the instrument, not the actor.
  if (button.staffOnly) {
    const [presser] = await app.db
      .select({ isStaff: users.isStaff })
      .from(users)
      .where(eq(users.id, input.actorId))
      .limit(1);
    if (!presser?.isStaff) throw forbidden('That button is for yappy staff');
  }

  if (button.requiredPermissions) {
    // Throws forbidden if the presser lacks the bits in this conversation.
    await requirePermission(app.db, input.conversationId, input.actorId, BigInt(button.requiredPermissions));
  }

  const [sender] = await app.db
    .select({ id: users.id, isBot: users.isBot })
    .from(users)
    .where(eq(users.id, message.senderId!))
    .limit(1);
  if (!sender?.isBot) throw notFound('Button');

  const response = await dispatch(app, {
    botId: sender.id,
    actorId: input.actorId,
    conversationId: input.conversationId,
    messageId: input.messageId,
    customId: input.customId,
  });

  return applyResponse(app, {
    botId: sender.id,
    conversationId: input.conversationId,
    messageId: input.messageId,
    response,
  });
}

/**
 * Route the press to whichever bot owns the message.
 *
 * First-party (yapper) answers in-process and synchronously. A third-party
 * bot gets the press over its signed webhook and answers *later*, by editing
 * the message through the REST API with its own token — the same async model
 * as everything else it does. Both kinds flow through this one point so the
 * authorisation above applies identically to both.
 */
async function dispatch(
  app: FastifyInstance,
  input: { botId: string; actorId: string; conversationId: string; messageId: string; customId: string },
): Promise<InteractionResponse> {
  const handled = await handleYapperInteraction(app, input);
  if (handled) return handled;

  const [application] = await app.db
    .select({ id: applications.id, webhookUrl: applications.webhookUrl })
    .from(applications)
    .where(and(eq(applications.botUserId, input.botId), isNull(applications.revokedAt)))
    .limit(1);

  if (application?.webhookUrl) {
    // The invoker's authority rides along, so the bot can make its own
    // decision without a follow-up call — and has no excuse not to.
    const ctx = await requireMember(app.db, input.conversationId, input.actorId);
    const [flags] = await app.db
      .select({ isStaff: users.isStaff })
      .from(users)
      .where(eq(users.id, input.actorId))
      .limit(1);

    await sendInteractionToBot(app, application.id, {
      conversationId: input.conversationId,
      messageId: input.messageId,
      customId: input.customId,
      invoker: {
        userId: input.actorId,
        permissions: ctx.permissions.toString(),
        isStaff: Boolean(flags?.isStaff),
      },
    });
  }

  // A bot with no handler still owes the presser an answer, and leaving the
  // button live would invite them to keep pressing it.
  return { kind: 'ack' };
}

async function applyResponse(
  app: FastifyInstance,
  input: {
    botId: string;
    conversationId: string;
    messageId: string;
    response: InteractionResponse;
  },
): Promise<unknown> {
  const { response } = input;

  if (response.kind === 'update') {
    return app.messages.rewriteBotMessage(input.botId, input.messageId, {
      ...(response.content !== undefined ? { content: response.content } : {}),
      ...(response.embeds !== undefined ? { embeds: response.embeds } : {}),
      ...(response.components !== undefined ? { components: response.components } : {}),
    });
  }

  if (response.kind === 'reply') {
    const result = await app.messages.send(input.botId, input.conversationId, {
      nonce: `interaction_${newId()}`,
      type: 'text',
      content: response.content ?? null,
      embeds: response.embeds,
      components: response.components,
      silent: false,
    } as never);
    return result.message;
  }

  return null;
}
