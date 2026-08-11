CREATE TABLE "live_locations" (
	"message_id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"accuracy" double precision,
	"heading" double precision,
	"expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "live_locations" ADD CONSTRAINT "live_locations_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_locations" ADD CONSTRAINT "live_locations_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_locations" ADD CONSTRAINT "live_locations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "live_location_active_idx" ON "live_locations" USING btree ("conversation_id") WHERE "live_locations"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "live_location_expiry_idx" ON "live_locations" USING btree ("expires_at") WHERE "live_locations"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "live_location_user_idx" ON "live_locations" USING btree ("user_id");