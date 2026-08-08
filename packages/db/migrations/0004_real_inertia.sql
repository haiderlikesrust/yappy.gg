ALTER TYPE "public"."conversation_type" ADD VALUE 'space';--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "conversations_parent_idx" ON "conversations" USING btree ("parent_id","position","title") WHERE "conversations"."parent_id" is not null and "conversations"."deleted_at" is null;