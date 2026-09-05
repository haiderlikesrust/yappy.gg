import { and, desc, devices, eq, isNull, ne } from '@yappy/db';
import { notFound, registerPushBody } from '@yappy/shared';
import type { FastifyInstance } from 'fastify';
import { forgetAuthUser } from '../plugins/auth.js';

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

  /**
   * Everything but this device, in one tap.
   *
   * The list is the security surface, and what people do on it after a scare
   * is sign out everywhere else. A dozen stale web sessions at one revoke
   * each is how they give up halfway. The current device stays: being signed
   * out by the screen that just confirmed you are safe is the wrong
   * surprise. A static segment, so the router picks it over `/:id` whatever
   * the order; it sits above only so the two revokes read together.
   */
  app.delete('/others', { preHandler: app.authenticate }, async (req, reply) => {
    const rows = await app.db
      .update(devices)
      .set({ revokedAt: new Date() })
      .where(
        and(eq(devices.userId, req.user.id), ne(devices.id, req.deviceId), isNull(devices.revokedAt)),
      )
      .returning({ id: devices.id });
    forgetAuthUser(req.user.id);
    // One control event per device, the same shape the single revoke sends;
    // the gateway closes and forgets that device's sockets on it.
    for (const row of rows) {
      await app.events.toUser(req.user.id, 'session.update', { deviceId: row.id, revoked: true });
    }
    return reply.send({ revoked: rows.length });
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
    // The auth cache holds this device's revokedAt as null for its TTL; every
    // other revoker forgets, and this one — the devices screen — did not.
    forgetAuthUser(req.user.id);
    // The gateway closes and forgets the revoked device's sockets on this event.
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
