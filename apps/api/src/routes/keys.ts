import { and, cryptoIdentities, devices, eq, inArray, isNull, keyVerifications, oneTimePreKeys, sql as raw } from '@yappy/db';
import { claimKeysBody, forbidden, newId, notFound, publishKeysBody, verifyKeysBody } from '@yappy/shared';
import type { FastifyInstance } from 'fastify';

/**
 * E2EE key directory.
 *
 * The server hands out public keys and vends one-time prekeys. It never sees a
 * private key and never derives a session. Messages today are server-visible —
 * this is the scaffolding that makes opt-in encrypted DMs a feature flag rather
 * than a migration nobody can perform. See packages/db/src/schema/crypto.ts for
 * why it ships before it is used.
 */
export async function keyRoutes(app: FastifyInstance) {
  app.post('/publish', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const body = publishKeysBody.parse(req.body);

    // A device may only publish keys for itself. Otherwise anyone could
    // overwrite another device's identity key and silently become them.
    if (body.deviceId !== req.deviceId) throw forbidden('You can only publish keys for the current device');

    const fingerprint = await computeFingerprint(body.identityKey);

    await app.db.transaction(async (tx) => {
      await tx
        .insert(cryptoIdentities)
        .values({
          deviceId: body.deviceId,
          userId: req.user.id,
          identityKey: body.identityKey,
          signedPreKeyId: body.signedPreKey.id,
          signedPreKey: body.signedPreKey.key,
          signedPreKeySignature: body.signedPreKey.signature,
          fingerprint,
        })
        .onConflictDoUpdate({
          target: cryptoIdentities.deviceId,
          set: {
            // The identity key is intentionally NOT updated here. Rotating it
            // is a visible, alarming event ("safety number changed") and goes
            // through its own endpoint.
            signedPreKeyId: body.signedPreKey.id,
            signedPreKey: body.signedPreKey.key,
            signedPreKeySignature: body.signedPreKey.signature,
            signedPreKeyRotatedAt: new Date(),
          },
        });

      if (body.oneTimePreKeys.length > 0) {
        await tx
          .insert(oneTimePreKeys)
          .values(
            body.oneTimePreKeys.map((k) => ({
              deviceId: body.deviceId,
              keyId: k.id,
              publicKey: k.key,
            })),
          )
          .onConflictDoNothing();
      }
    });

    const availRows = (await app.db.execute(
      raw`select count(*)::int as available from one_time_pre_keys
           where device_id = ${body.deviceId}::uuid and claimed_at is null`,
    )) as unknown as Array<{ available: number }>;

    return reply.send({ fingerprint, availablePreKeys: availRows[0]?.available ?? 0 });
  });

  /** Client polls this and tops up when it gets low. */
  app.get('/count', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const availRows = (await app.db.execute(
      raw`select count(*)::int as available from one_time_pre_keys
           where device_id = ${req.deviceId}::uuid and claimed_at is null`,
    )) as unknown as Array<{ available: number }>;
    return reply.send({ availablePreKeys: availRows[0]?.available ?? 0 });
  });

  /**
   * Claim key bundles for a set of users, one per active device.
   *
   * The claim deletes the one-time prekey in the same statement, so two senders
   * can never be handed the same key — reusing a one-time prekey breaks the
   * forward-secrecy guarantee it exists to provide.
   *
   * When a device is out of one-time keys the bundle comes back without one.
   * That is a documented, degraded-but-safe mode in X3DH, not an error.
   */
  app.post('/claim', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const body = claimKeysBody.parse(req.body);

    const identities = await app.db
      .select({ identity: cryptoIdentities, deviceId: devices.id })
      .from(cryptoIdentities)
      .innerJoin(devices, eq(devices.id, cryptoIdentities.deviceId))
      .where(
        and(
          inArray(cryptoIdentities.userId, body.userIds),
          isNull(devices.revokedAt),
          ...(body.deviceIds?.length
            ? [inArray(cryptoIdentities.deviceId, body.deviceIds)]
            : []),
        ),
      );

    // Asking for a specific set and getting none of them is an answer, not a
    // failure: it means every device the caller named has since been revoked.
    if (identities.length === 0 && !body.deviceIds) throw notFound('Keys');

    const bundles = await Promise.all(
      identities.map(async ({ identity }) => {
        const claimed = (await app.db.execute(
          raw`update one_time_pre_keys
                 set claimed_at = now()
               where (device_id, key_id) = (
                 select device_id, key_id from one_time_pre_keys
                  where device_id = ${identity.deviceId}::uuid and claimed_at is null
                  order by key_id
                  for update skip locked
                  limit 1
               )
               returning key_id, public_key`,
        )) as unknown as Array<{ key_id: number; public_key: string }>;

        return {
          userId: identity.userId,
          deviceId: identity.deviceId,
          identityKey: identity.identityKey,
          fingerprint: identity.fingerprint,
          signedPreKey: {
            id: identity.signedPreKeyId,
            key: identity.signedPreKey,
            signature: identity.signedPreKeySignature,
          },
          oneTimePreKey: claimed[0]
            ? { id: claimed[0].key_id, key: claimed[0].public_key }
            : null,
        };
      }),
    );

    return reply.send({ bundles });
  });

  /** Every device key for one user — powers the "verify safety number" screen. */
  app.get('/user/:id', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const rows = await app.db
      .select({ identity: cryptoIdentities, deviceName: devices.name, platform: devices.platform })
      .from(cryptoIdentities)
      .innerJoin(devices, eq(devices.id, cryptoIdentities.deviceId))
      .where(and(eq(cryptoIdentities.userId, id), isNull(devices.revokedAt)));

    /**
     * One number for the person, not one per device.
     *
     * Nobody compares six fingerprints down a phone line. This folds every
     * device they currently have into a single value, which is what gets read
     * aloud and what a verification is recorded against — so adding a device
     * changes it, and a stale verification says so instead of quietly
     * covering a device that was never checked.
     */
    const combined = await combinedFingerprint(rows.map((r) => r.identity.identityKey));

    const [verification] = await app.db
      .select({ fingerprint: keyVerifications.fingerprint, verifiedAt: keyVerifications.verifiedAt })
      .from(keyVerifications)
      .where(
        and(eq(keyVerifications.verifierId, req.user.id), eq(keyVerifications.verifiedUserId, id)),
      )
      .limit(1);

    return reply.send({
      devices: rows.map((r) => ({
        deviceId: r.identity.deviceId,
        name: r.deviceName,
        platform: r.platform,
        identityKey: r.identity.identityKey,
        fingerprint: r.identity.fingerprint,
      })),
      safetyNumber: combined,
      verified: Boolean(verification) && verification!.fingerprint === combined,
      /** Verified once, but not against what they have now. */
      changedSinceVerified: Boolean(verification) && verification!.fingerprint !== combined,
      verifiedAt: verification?.verifiedAt?.toISOString() ?? null,
    });
  });

  /**
   * Record having compared numbers with somebody.
   *
   * The client sends back the number it displayed, and the server refuses if
   * that is not what the directory says right now — otherwise a device added
   * between the screen rendering and the button being pressed would be marked
   * verified without anybody having looked at it.
   */
  app.post('/verify', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const body = verifyKeysBody.parse(req.body);

    const rows = await app.db
      .select({ identityKey: cryptoIdentities.identityKey })
      .from(cryptoIdentities)
      .innerJoin(devices, eq(devices.id, cryptoIdentities.deviceId))
      .where(and(eq(cryptoIdentities.userId, body.userId), isNull(devices.revokedAt)));

    if (rows.length === 0) throw notFound('Keys');

    const combined = await combinedFingerprint(rows.map((r) => r.identityKey));
    if (combined !== body.fingerprint) {
      return reply.status(409).send({
        error: {
          code: 'stale_fingerprint',
          message: 'Their devices changed while you were looking. Compare the new number.',
        },
        safetyNumber: combined,
      });
    }

    await app.db
      .insert(keyVerifications)
      .values({
        id: newId(),
        verifierId: req.user.id,
        verifiedUserId: body.userId,
        fingerprint: combined,
        isValid: true,
        verifiedAt: new Date(),
      })
      .onConflictDoNothing();

    // A second verification of a *changed* number replaces the first: the row
    // is one per pair, and what matters is the most recent comparison.
    await app.db
      .update(keyVerifications)
      .set({ fingerprint: combined, isValid: true, verifiedAt: new Date() })
      .where(
        and(
          eq(keyVerifications.verifierId, req.user.id),
          eq(keyVerifications.verifiedUserId, body.userId),
        ),
      );

    return reply.send({ verified: true, safetyNumber: combined });
  });

  /** Undo it. Not an error path — people re-check, and change their minds. */
  app.delete('/verify/:id', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await app.db
      .delete(keyVerifications)
      .where(
        and(eq(keyVerifications.verifierId, req.user.id), eq(keyVerifications.verifiedUserId, id)),
      );
    return reply.send({ verified: false });
  });
}

/**
 * One fingerprint over every identity key a person currently has.
 *
 * Sorted first, so the number does not depend on the order the database
 * happened to return rows in — two people comparing screens must see the
 * same thing, and one of them refreshing must not change it.
 */
async function combinedFingerprint(identityKeys: string[]): Promise<string> {
  return computeFingerprint([...identityKeys].sort().join('|'));
}

/** Short, human-comparable fingerprint of an identity key. */
async function computeFingerprint(identityKey: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identityKey));
  const hex = Buffer.from(digest).toString('hex');
  // Grouped into blocks of five, the way every safety-number UI displays it.
  return (hex.match(/.{1,5}/g) ?? []).slice(0, 12).join(' ');
}
