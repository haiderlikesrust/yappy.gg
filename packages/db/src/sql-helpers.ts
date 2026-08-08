import { sql, type SQL } from 'drizzle-orm';

/**
 * Array literals for hand-written SQL.
 *
 * Embedding a JS array directly in a Drizzle `sql` template does **not**
 * produce a Postgres array — it binds as a single scalar, and
 * `= any($1::uuid[])` then fails with "malformed array literal". These helpers
 * expand the array into individual bound parameters, which keeps it
 * parameterised (no injection surface) and correctly typed.
 *
 *   where id = any(${uuidArray(ids)})
 */
export function uuidArray(values: readonly string[]): SQL {
  if (values.length === 0) return sql`'{}'::uuid[]`;
  return sql`array[${sql.join(
    values.map((v) => sql`${v}::uuid`),
    sql`, `,
  )}]`;
}

export function textArray(values: readonly string[]): SQL {
  if (values.length === 0) return sql`'{}'::text[]`;
  return sql`array[${sql.join(
    values.map((v) => sql`${v}::text`),
    sql`, `,
  )}]`;
}
