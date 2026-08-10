ALTER TABLE "users" ALTER COLUMN "privacy" SET DEFAULT '{"whoCanDm":"everyone","whoCanAddToGroups":"contacts","whoCanSeeLastSeen":"contacts","whoCanSeeAvatar":"everyone","whoCanCall":"contacts","readReceipts":true,"typingIndicators":true,"ambientPresence":true,"discoverableByPhone":true,"discoverableByUsername":true}'::jsonb;--> statement-breakpoint
ALTER TABLE "presence" ADD COLUMN "viewing_conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "ends_warned_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "users_custom_status_expiry_idx" ON "users" USING btree ("custom_status_expires_at") WHERE "users"."custom_status_expires_at" is not null;--> statement-breakpoint
CREATE INDEX "presence_viewing_idx" ON "presence" USING btree ("viewing_conversation_id") WHERE "presence"."viewing_conversation_id" is not null;--> statement-breakpoint
CREATE INDEX "conversations_ends_idx" ON "conversations" USING btree ("ends_at") WHERE "conversations"."ends_at" is not null and "conversations"."deleted_at" is null;