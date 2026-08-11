import { randomBytes } from 'node:crypto';
import { and, applications, DEFAULT_PRIVACY, eq, isNull, users } from '@yappy/db';
import {
  conflict,
  createBotBody,
  forbidden,
  newId,
  notFound,
  setBotCommandsBody,
  setBotWebhookBody,
  updateBotBody,
} from '@yappy/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { newBotToken } from '../lib/tokens.js';
import { toPublicUser } from '../lib/serialize.js';

/**
 * Bots.
 *
 * A bot is a user row plus an application record holding its credential. That
 * means everything a bot does goes through the same membership and permission
 * checks as a person — there is no privileged side door, and revoking a bot is
 * the same operation as kicking a member.
 *
 * The token is shown exactly once, at creation and at rotation. Storing it
 * anywhere retrievable would make this endpoint a much better target than the
 * bots themselves.
 *
 * Mounted twice: at /apps for the app (ordinary access token), and at
 * /portal/apps for the developer portal (portal token). Same handlers, same
 * ownership checks — the whole point of the portal session is managing
 * applications, so it gets exactly these routes and nothing else. `opts.portal`
 * selects which credential authenticates and where the owner id comes from.
 */
export async function botRoutes(app: FastifyInstance, opts: { portal?: boolean }) {
  const guard = opts.portal ? app.authenticatePortal : app.authenticateOnboarded;
  const ownerOf = (req: FastifyRequest): string =>
    opts.portal ? req.portalUser.id : req.user.id;

  /** Who am I — the first call most bot SDKs make on boot. App-side only:
   *  a bot authenticates with its own token, never through the portal. */
  if (!opts.portal) {
    app.get('/me', { preHandler: app.authenticate }, async (req, reply) => {
      if (!req.application) throw forbidden('This endpoint requires a bot token');
      return reply.send({
        application: {
          id: req.application.id,
          name: req.application.name,
          description: req.application.description,
          isPublic: req.application.isPublic,
        },
        user: toPublicUser(req.user),
      });
    });
  }

  /**
   * The bot directory: every bot its author marked public.
   *
   * `isPublic` has meant "listed in the bot directory and addable by anyone"
   * since the column was written, and until now there was no directory for it
   * to mean anything in. Adding one is the whole change — a bot joins a group
   * through the ordinary add-members endpoint, with the ordinary permission
   * check and the ordinary "X added Y" system message, because a bot is a user
   * row and there is deliberately no privileged side door.
   *
   * Returns the bot's **user** id, not the application id. That is what you add
   * to a conversation, and handing back the application id would be an
   * invitation to try adding the wrong one.
   *
   * Only what a chooser needs: no token prefix, no webhook URL, no owner. This
   * is the one bot endpoint any signed-in account may call, so it says as
   * little as possible.
   */
  if (!opts.portal) {
    app.get('/directory', { preHandler: app.authenticateOnboarded }, async (_req, reply) => {
      const rows = await app.db
        .select({
          id: applications.id,
          botUserId: applications.botUserId,
          name: applications.name,
          description: applications.description,
          commands: applications.commands,
          user: users,
        })
        .from(applications)
        .innerJoin(users, eq(users.id, applications.botUserId))
        .where(
          and(
            eq(applications.isPublic, true),
            isNull(applications.revokedAt),
            isNull(users.deletedAt),
          ),
        )
        .orderBy(applications.name)
        .limit(100);

      return reply.send({
        bots: rows.map((r) => ({
          id: r.id,
          botUserId: r.botUserId,
          name: r.name,
          description: r.description,
          /** So a chooser can say what it answers to before you add it. */
          commandCount: Array.isArray(r.commands) ? r.commands.length : 0,
          user: toPublicUser(r.user),
        })),
      });
    });
  }

  app.get('/', { preHandler: guard }, async (req, reply) => {
    const rows = await app.db
      .select({ application: applications, user: users })
      .from(applications)
      .innerJoin(users, eq(users.id, applications.botUserId))
      .where(and(eq(applications.ownerId, ownerOf(req)), isNull(applications.revokedAt)));

    return reply.send({ applications: rows.map((r) => serializeApp(r.application, r.user)) });
  });

  app.post('/', { preHandler: guard }, async (req, reply) => {
    const body = createBotBody.parse(req.body);
    // A bot is an account; creating them should cost the same as anything else
    // that mints one.
    await app.limiter.consume(`user:${ownerOf(req)}`, 'conversation.create');

    const [taken] = await app.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.username, body.username), isNull(users.deletedAt)))
      .limit(1);
    if (taken) throw conflict('That username is taken');

    const credential = newBotToken();

    const created = await app.db.transaction(async (tx) => {
      const [botUser] = await tx
        .insert(users)
        .values({
          id: newId(),
          username: body.username,
          displayName: body.name,
          bio: body.description ?? null,
          isBot: true,
          // A bot nobody can add to a group is furniture. The rest of the
          // defaults (which are conservative) still apply.
          privacy: { ...DEFAULT_PRIVACY, whoCanAddToGroups: 'everyone', whoCanDm: 'everyone' },
        })
        .returning();

      const [application] = await tx
        .insert(applications)
        .values({
          id: newId(),
          ownerId: ownerOf(req),
          botUserId: botUser!.id,
          name: body.name,
          description: body.description ?? null,
          tokenHash: credential.hash,
          tokenPrefix: credential.prefix,
          isPublic: body.isPublic,
        })
        .returning();

      return { application: application!, botUser: botUser! };
    });

    return reply.status(201).send({
      application: serializeApp(created.application, created.botUser),
      // Once. There is no endpoint that will show it again.
      token: credential.token,
    });
  });

  app.patch('/:id', { preHandler: guard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = updateBotBody.parse(req.body);
    const existing = await owned(app, id, ownerOf(req));

    /**
     * Both writes or neither.
     *
     * These were two statements outside a transaction, and the second one threw
     * whenever the body carried only `isPublic`: `set({})` is a runtime error in
     * Drizzle ("No values to set"), not a no-op. The application row had already
     * been written by then, so the flag flipped, the request 500'd, and the
     * portal went on showing the old state — the caller was told it failed while
     * the bot was, in fact, now listed. That is the worst possible outcome for a
     * visibility setting.
     *
     * Nothing had ever sent `isPublic` on its own until the portal grew a toggle
     * for it, which is how something this shallow survived this long.
     */
    return await app.db.transaction(async (tx) => {
      const [application] = await tx
        .update(applications)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.isPublic !== undefined ? { isPublic: body.isPublic } : {}),
        })
        .where(eq(applications.id, id))
        .returning();

      // Keep the bot's visible identity in step, when there is any to change.
      const identityChanged = body.name !== undefined || body.description !== undefined;

      const [botUser] = identityChanged
        ? await tx
            .update(users)
            .set({
              ...(body.name !== undefined ? { displayName: body.name } : {}),
              ...(body.description !== undefined ? { bio: body.description } : {}),
            })
            .where(eq(users.id, existing.botUserId))
            .returning()
        : await tx.select().from(users).where(eq(users.id, existing.botUserId)).limit(1);

      return reply.send({ application: serializeApp(application!, botUser!) });
    });
  });

  /** Rotate. The previous token stops working immediately — no grace window,
   *  because the reason to rotate is usually that the old one leaked. */
  app.post('/:id/token', { preHandler: guard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await owned(app, id, ownerOf(req));

    const credential = newBotToken();
    await app.db
      .update(applications)
      .set({
        tokenHash: credential.hash,
        tokenPrefix: credential.prefix,
        tokenIssuedAt: new Date(),
      })
      .where(eq(applications.id, id));

    return reply.send({ token: credential.token, tokenPrefix: credential.prefix });
  });

  app.delete('/:id', { preHandler: guard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await owned(app, id, ownerOf(req));

    await app.db.transaction(async (tx) => {
      await tx.update(applications).set({ revokedAt: new Date() }).where(eq(applications.id, id));
      // Soft-delete: the bot's past messages keep their author, and the
      // username stays claimed so a later bot cannot impersonate this one.
      await tx.update(users).set({ deletedAt: new Date() }).where(eq(users.id, existing.botUserId));
    });

    return reply.send({ deleted: true });
  });

  /**
   * Declare the bot's slash commands.
   *
   * Validated hard: `requiredPermissions` and `staffOnly` are what the
   * commands endpoint and the button-press path enforce against members, so
   * a malformed declaration is refused rather than stored and half-ignored.
   */
  app.put('/:id/commands', { preHandler: guard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = setBotCommandsBody.parse(req.body);
    await owned(app, id, ownerOf(req));

    const names = body.commands.map((c) => c.name);
    if (new Set(names).size !== names.length) {
      throw conflict('Two commands share a name');
    }

    await app.db.update(applications).set({ commands: body.commands }).where(eq(applications.id, id));
    return reply.send({ commands: body.commands });
  });

  /**
   * Set (or clear) the webhook the bot receives events on.
   *
   * The signing secret is minted here and shown once, exactly like the token:
   * a webhook without a verifiable signature is an endpoint anyone on the
   * internet can feed fabricated events.
   */
  app.put('/:id/webhook', { preHandler: guard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = setBotWebhookBody.parse(req.body);
    await owned(app, id, ownerOf(req));

    if (body.url === null) {
      await app.db
        .update(applications)
        .set({ webhookUrl: null, webhookSecret: null })
        .where(eq(applications.id, id));
      return reply.send({ webhookUrl: null });
    }

    const url = new URL(body.url);
    if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
      throw forbidden('Webhooks must be https (localhost excepted, for development)');
    }

    const secret = randomBytes(32).toString('hex');
    await app.db
      .update(applications)
      .set({ webhookUrl: body.url, webhookSecret: secret })
      .where(eq(applications.id, id));

    return reply.send({ webhookUrl: body.url, secret });
  });
}

async function owned(app: FastifyInstance, id: string, ownerId: string) {
  const [row] = await app.db
    .select()
    .from(applications)
    .where(and(eq(applications.id, id), isNull(applications.revokedAt)))
    .limit(1);
  // 404 rather than 403 — application ids are not the caller's business.
  if (!row || row.ownerId !== ownerId) throw notFound('Application');
  return row;
}

function serializeApp(application: typeof applications.$inferSelect, botUser: typeof users.$inferSelect) {
  return {
    id: application.id,
    name: application.name,
    description: application.description,
    isPublic: application.isPublic,
    tokenPrefix: application.tokenPrefix,
    tokenIssuedAt: application.tokenIssuedAt.toISOString(),
    lastUsedAt: application.lastUsedAt?.toISOString() ?? null,
    createdAt: application.createdAt.toISOString(),
    commands: application.commands ?? [],
    /** The URL only — the secret is shown once at set time and never again. */
    webhookUrl: application.webhookUrl,
    bot: toPublicUser(botUser),
  };
}
