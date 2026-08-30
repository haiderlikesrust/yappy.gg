ALTER TABLE "conversations" ADD COLUMN "is_forum" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "thread_last_reply_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "title" text;--> statement-breakpoint
CREATE INDEX "messages_forum_idx" ON "messages" USING btree ("conversation_id",coalesce("thread_last_reply_at", "created_at") desc) WHERE "messages"."thread_root_id" is null and "messages"."deleted_at" is null;--> statement-breakpoint
-- Backfill the new column only. `thread_reply_count` is already correct on
-- every existing row: it is maintained by the sync_thread_count trigger, not
-- by application code, so it needs nothing here.
UPDATE "messages" r SET "thread_last_reply_at" = c.last_at
FROM (
  SELECT "thread_root_id" AS root, max("created_at") AS last_at
    FROM "messages"
   WHERE "thread_root_id" IS NOT NULL AND "deleted_at" IS NULL
   GROUP BY "thread_root_id"
) c
WHERE r."id" = c.root;
