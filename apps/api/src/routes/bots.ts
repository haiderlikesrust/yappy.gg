import { and, applications, DEFAULT_PRIVACY, eq, isNull, users } from '@yappy/db';
import {
  conflict,
  createBotBody,
  forbidden,
  newId,
  notFound,
  updateBotBody,
} from '@yappy/shared';
import type { FastifyInstance } from 'fastify';
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
 */
export async function botRoutes(app: FastifyInstance) {
  /** Who am I — the first call most bot SDKs make on boot. */
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

  app.get('/', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const rows = await app.db
      .select({ application: applications, user: users })
      .from(applications)
      .innerJoin(users, eq(users.id, applications.botUserId))
      .where(and(eq(applications.ownerId, req.user.id), isNull(applications.revokedAt)));

    return reply.send({ applications: rows.map((r) => serializeApp(r.application, r.user)) });
  });

  app.post('/', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const body = createBotBody.parse(req.body);
    // A bot is an account; creating them should cost the same as anything else
    // that mints one.
    await app.limiter.consume(`user:${req.user.id}`, 'conversation.create');

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
          ownerId: req.user.id,
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

  app.patch('/:id', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = updateBotBody.parse(req.body);
    const existing = await owned(app, id, req.user.id);

    const [application] = await app.db
      .update(applications)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.isPublic !== undefined ? { isPublic: body.isPublic } : {}),
      })
      .where(eq(applications.id, id))
      .returning();

    // Keep the bot's visible identity in step with its application record.
    const [botUser] = await app.db
      .update(users)
      .set({
        ...(body.name !== undefined ? { displayName: body.name } : {}),
        ...(body.description !== undefined ? { bio: body.description } : {}),
      })
      .where(eq(users.id, existing.botUserId))
      .returning();

    return reply.send({ application: serializeApp(application!, botUser!) });
  });

  /** Rotate. The previous token stops working immediately — no grace window,
   *  because the reason to rotate is usually that the old one leaked. */
  app.post('/:id/token', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await owned(app, id, req.user.id);

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

  app.delete('/:id', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await owned(app, id, req.user.id);

    await app.db.transaction(async (tx) => {
      await tx.update(applications).set({ revokedAt: new Date() }).where(eq(applications.id, id));
      // Soft-delete: the bot's past messages keep their author, and the
      // username stays claimed so a later bot cannot impersonate this one.
      await tx.update(users).set({ deletedAt: new Date() }).where(eq(users.id, existing.botUserId));
    });

    return reply.send({ deleted: true });
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
    bot: toPublicUser(botUser),
  };
}
