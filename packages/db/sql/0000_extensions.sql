-- Applied BEFORE the generated Drizzle migrations: the schema references
-- citext and pg_trgm column types, so the extensions must already exist.

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gin;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Blind-index pepper for contact sync. Stored in the database rather than the
-- app config so it is backed up with the data it protects; rotate by
-- recomputing every users.phone_hash in a maintenance job.
CREATE TABLE IF NOT EXISTS server_secrets (
  key   text PRIMARY KEY,
  value text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO server_secrets (key, value)
VALUES ('phone_pepper', encode(gen_random_bytes(32), 'hex'))
ON CONFLICT (key) DO NOTHING;
