import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

/**
 * Migration runner.
 *
 * Three phases, in this order and for this reason:
 *
 *   1. sql/0000_extensions.sql — creates citext and pg_trgm. Must precede the
 *      generated migrations, which declare columns *of* those types.
 *   2. Drizzle's generated migrations — tables, columns, indexes.
 *   3. The remaining sql/*.sql — constraints, generated columns, triggers and
 *      functions that Drizzle's DSL cannot express. Every statement in these
 *      files is idempotent, so they are re-applied on every run and act as the
 *      source of truth rather than as one-way migrations.
 */

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');

/**
 * No hardcoded fallback. A default connection string is convenient exactly once
 * and then quietly migrates or seeds whatever database happens to be listening
 * on localhost — including, on a developer's machine, the wrong one.
 */
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Run via pnpm (which loads .env) or export it.');
  process.exit(1);
}

async function runSqlFile(sql: postgres.Sql, path: string) {
  const contents = await readFile(path, 'utf8');
  // postgres.js `unsafe` sends the whole thing as a simple query, which allows
  // multiple statements and the dollar-quoted plpgsql bodies in 0002/0003.
  await sql.unsafe(contents);
}

async function main() {
  const sql = postgres(url, { max: 1, onnotice: () => {} });

  try {
    const sqlDir = join(pkgRoot, 'sql');
    const files = (await readdir(sqlDir)).filter((f) => f.endsWith('.sql')).sort();

    const extensions = files.filter((f) => f.startsWith('0000_'));
    const rest = files.filter((f) => !f.startsWith('0000_'));

    for (const file of extensions) {
      console.log(`→ extensions: ${file}`);
      await runSqlFile(sql, join(sqlDir, file));
    }

    const migrationsFolder = join(pkgRoot, 'migrations');
    let hasMigrations = false;
    try {
      hasMigrations = (await readdir(migrationsFolder)).some((f) => f.endsWith('.sql'));
    } catch {
      hasMigrations = false;
    }

    if (hasMigrations) {
      console.log('→ drizzle migrations');
      await migrate(drizzle(sql), { migrationsFolder });
    } else {
      console.warn('! no generated migrations found — run `pnpm db:generate` first');
    }

    for (const file of rest) {
      console.log(`→ post-migration: ${file}`);
      await runSqlFile(sql, join(sqlDir, file));
    }

    console.log('✓ database up to date');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('✗ migration failed');
  console.error(err);
  process.exit(1);
});
