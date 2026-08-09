CREATE TABLE "custom_emojis" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"name" text NOT NULL,
	"media_id" uuid NOT NULL,
	"animated" boolean DEFAULT false NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_staff" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "system_key" text;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "webhook_url" text;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "webhook_secret" text;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "staff_message_id" uuid;--> statement-breakpoint
ALTER TABLE "custom_emojis" ADD CONSTRAINT "custom_emojis_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_emojis" ADD CONSTRAINT "custom_emojis_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_emojis" ADD CONSTRAINT "custom_emojis_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "custom_emojis_name_uq" ON "custom_emojis" USING btree ("conversation_id","name") WHERE "custom_emojis"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "custom_emojis_conversation_idx" ON "custom_emojis" USING btree ("conversation_id") WHERE "custom_emojis"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_system_key_uq" ON "conversations" USING btree ("system_key") WHERE "conversations"."system_key" is not null;