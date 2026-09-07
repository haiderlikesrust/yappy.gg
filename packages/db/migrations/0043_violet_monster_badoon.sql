DROP INDEX "scheduled_due_idx";--> statement-breakpoint
ALTER TABLE "scheduled_messages" ADD COLUMN "sent_at" timestamp with time zone;--> statement-breakpoint
UPDATE "scheduled_messages" SET "sent_at" = "updated_at" WHERE "sent_message_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "scheduled_due_idx" ON "scheduled_messages" USING btree ("send_at") WHERE "scheduled_messages"."sent_at" is null and "scheduled_messages"."cancelled_at" is null and "scheduled_messages"."failed_at" is null;
