import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export * from './schema/index.js';
export * from './bus.js';
export * from './sql-helpers.js';
export {
  sql, eq, ne, and, or, not, inArray, notInArray, lt, lte, gt, gte, desc, asc,
  isNull, isNotNull, count, sum, max, min, exists, like, ilike, between,
  arrayContains, getTableColumns,
} from 'drizzle-orm';
/** Self-joins need an alias; re-exported so app code never imports drizzle directly. */
export { alias } from 'drizzle-orm/pg-core';

export type Database = ReturnType<typeof createDb>['db'];
export type Sql = ReturnType<typeof postgres>;

/**
 * The handle Drizzle hands to a `db.transaction()` callback.
 *
 * It is *not* assignable to `Database` (it has no `$client`), so anything that
 * accepts either — a helper called both inside and outside a transaction —
 * needs `Executor` rather than `Database`.
 */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type Executor = Database | Transaction;

export interface DbOptions {
  url: string;
  max?: number;
  /** Set on the LISTEN/NOTIFY connection, which must never be pooled away. */
  idleTimeout?: number;
  onNotice?: (notice: unknown) => void;
  debug?: boolean;
}

export function createDb(opts: DbOptions) {
  const sql = postgres(opts.url, {
    max: opts.max ?? 20,
    idle_timeout: opts.idleTimeout ?? 30,
    max_lifetime: 60 * 30,
    // Deliberately NOT overriding the bigint parser. postgres.js returns int8
    // as a string by default and Drizzle's own column mappers convert from
    // there — `mode: 'number'` for the seq counters (no conversation will reach
    // 2^53 messages) and `mode: 'bigint'` for the permission bitfields, which
    // genuinely need 64 bits. Installing `postgres.BigInt` globally would hand
    // Drizzle a type its mappers do not expect.
    prepare: true,
    onnotice: opts.onNotice ? (n) => opts.onNotice?.(n) : () => {},
    transform: { undefined: null },
  });

  const db = drizzle(sql, { schema, logger: opts.debug ?? false });
  return { db, sql, schema };
}

/**
 * Dedicated connection for LISTEN/NOTIFY.
 *
 * A listening session holds its connection for as long as it is subscribed, so
 * it must not come out of the request pool — one gateway node with 50k sockets
 * would otherwise starve the API of connections. `postgres.js` gives us
 * automatic re-LISTEN on reconnect, which matters because a dropped listener is
 * silent: no error, just events that stop arriving.
 */
export function createListener(url: string) {
  return postgres(url, {
    max: 1,
    idle_timeout: 0,
    max_lifetime: 0,
    connection: { application_name: 'yappy-listener' },
    onnotice: () => {},
  });
}
