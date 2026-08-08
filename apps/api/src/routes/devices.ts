import { and, desc, devices, eq, isNull } from '@yappy/db';
import { notFound, registerPushBody } from '@yappy/shared';
import type { FastifyInstance } from 'fastify';

export async function deviceRoutes(app: FastifyInstance) {
  /** The "active sessions" screen — a security surface users actually check. */
  app.get('/', { preHandler: app.authenticate }, async (req, reply) => {
    const rows = await app.db
      .select({
        id: devices.id,
        name: devices.name,
        platform: devices.platform,
        appVersion: devices.appVersion,
        osVersion: devices.osVersion,
        lastIp: devices.lastIp,
        lastActiveAt: devices.lastActiveAt,
        createdAt: devices.createdAt,
        hasPush: devices.pushToken,
      })
      .from(devices)
      .where(and(eq(devices.userId, req.user.id), isNull(devices.revokedAt)))
      .orderBy(desc(devices.lastActiveAt));

    return reply.send({
      devices: rows.map((d) => ({
        id: d.id,
        name: d.name,
        platform: d.platform,
        appVersion: d.appVersion,
        osVersion: d.osVersion,
        lastIp: d.lastIp,
        lastActiveAt: d.lastActiveAt.toISOString(),
        createdAt: d.createdAt.toISOString(),
        pushEnabled: Boolean(d.hasPush),
        isCurrent: d.id === req.deviceId,
      })),
    });
  });

  app.delete('/:id', { preHandler: app.authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const [row] = await app.db
      .select({ id: devices.id })
      .from(devices)
      .where(and(eq(devices.id, id), eq(devices.userId, req.user.id)))
      .limit(1);
    if (!row) throw notFound('Device');

    await app.db.update(devices).set({ revokedAt: new Date() }).where(eq(devices.id, id));
    // The revoked device's gateway connection is closed by the control event.
    await app.events.toUser(req.user.id, 'session.update', { deviceId: id, revoked: true });
    return reply.send({ revoked: true });
  });

  /**
   * Push token registration.
   *
   * Tokens are per-install and rotate; the same token can also migrate between
   * users when a device is handed over, so registering clears it from any other
   * device row first. Otherwise the previous owner keeps receiving the new
   * owner's notifications — a real and very bad bug.
   */
  app.put('/me/push', { preHandler: app.authenticate }, async (req, reply) => {
    const body = registerPushBody.parse(req.body);

    await app.db.transaction(async (tx) => {
      await tx
        .update(devices)
        .set({ pushToken: null })
        .where(and(eq(devices.pushToken, body.token), isNull(devices.revokedAt)));

      await tx
        .update(devices)
        .set({
          pushToken: body.token,
          voipToken: body.voipToken ?? null,
          pushEnvironment: body.environment,
          pushFailureCount: 0,
          platform: body.platform,
        })
        .where(eq(devices.id, req.deviceId));
    });

    return reply.send({ ok: true });
  });

  app.delete('/me/push', { preHandler: app.authenticate }, async (req, reply) => {
    await app.db
      .update(devices)
      .set({ pushToken: null, voipToken: null })
      .where(eq(devices.id, req.deviceId));
    return reply.send({ ok: true });
  });
}
