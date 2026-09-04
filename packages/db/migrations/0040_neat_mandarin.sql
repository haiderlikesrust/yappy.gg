DROP INDEX "push_outbox_dedupe_idx";--> statement-breakpoint
ALTER TABLE "push_outbox" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
-- The index was never unique, so replayed fan-outs did insert duplicates.
-- Keep the oldest row per key before making it so, or this migration fails on
-- any production table that has ever seen a pg-boss batch retry.
DELETE FROM "push_outbox" a
  USING "push_outbox" b
 WHERE a."dedupe_key" IS NOT NULL
   AND a."dedupe_key" = b."dedupe_key"
   AND (a."created_at", a."id") > (b."created_at", b."id");--> statement-breakpoint
CREATE UNIQUE INDEX "push_outbox_dedupe_idx" ON "push_outbox" USING btree ("dedupe_key") WHERE "push_outbox"."dedupe_key" is not null;