import fp from 'fastify-plugin';
import PgBoss from 'pg-boss';
import { PgBus, createDb, type Database } from '@yappy/db';
import { QUEUES } from '@yappy/shared';
import type postgres from 'postgres';
import { env, isProd } from '../env.js';
import { EventPublisher } from '../lib/events.js';
import { RateLimiter } from '../lib/ratelimit.js';
import { Storage } from '../lib/storage.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Database;
    sql: postgres.Sql;
    bus: PgBus;
    events: EventPublisher;
    limiter: RateLimiter;
    storage: Storage;
    boss: PgBoss;
  }
}

/**
 * Wires the shared singletons onto the Fastify instance.
 *
 * All of them are Postgres-backed, which is the point: one connection string,
 * one thing to back up, one thing to monitor. `pg-boss` gets its own schema so
 * its tables do not mingle with the application's.
 */
export const corePlugin = fp(async (app) => {
  const { db, sql } = createDb({
    url: env.DATABASE_URL,
    max: env.DATABASE_MAX_POOL,
    debug: env.LOG_LEVEL === 'trace',
  });

  const bus = new PgBus(env.DATABASE_URL, sql, (err, ctx) => app.log.error({ err, ctx }, 'bus error'));

  const boss = new PgBoss({
    connectionString: env.DATABASE_URL,
    schema: 'pgboss',
    // The API only ever enqueues; the worker process does the consuming.
    supervise: false,
    max: 4,
  });
  boss.on('error', (err) => app.log.error({ err }, 'pg-boss error'));
  await boss.start();

  // See QUEUES in @yappy/shared: pg-boss v10 rejects a send to a queue that
  // does not exist yet, and the API may well boot before the worker.
  for (const queue of QUEUES) {
    await boss.createQueue(queue).catch((err) => app.log.warn({ err, queue }, 'createQueue failed'));
  }

  app.decorate('db', db);
  app.decorate('sql', sql);
  app.decorate('bus', bus);
  app.decorate('events', new EventPublisher(bus, db));
  app.decorate('limiter', new RateLimiter(sql, isProd));
  app.decorate('storage', new Storage());
  app.decorate('boss', boss);

  app.addHook('onClose', async () => {
    await bus.close().catch(() => {});
    await boss.stop({ graceful: true, timeout: 5_000 }).catch(() => {});
    await sql.end({ timeout: 5 }).catch(() => {});
  });
});
