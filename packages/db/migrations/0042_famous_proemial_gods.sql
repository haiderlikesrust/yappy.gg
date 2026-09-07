CREATE TABLE "community_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"creator_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"location" text DEFAULT '' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "community_reminders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"message_id" uuid,
	"event_id" uuid,
	"due_at" timestamp with time zone NOT NULL,
	"delivered_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "community_event_responses" (
	"event_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"response" text NOT NULL,
	"remind" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_event_responses_event_id_user_id_pk" PRIMARY KEY("event_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "saved_collections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_item_details" (
	"user_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"collection_id" uuid,
	"note" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_item_details_user_id_message_id_pk" PRIMARY KEY("user_id","message_id")
);
--> statement-breakpoint
CREATE TABLE "community_welcome_reads" (
	"user_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_welcome_reads_user_id_conversation_id_pk" PRIMARY KEY("user_id","conversation_id")
);
--> statement-breakpoint
ALTER TABLE "scheduled_messages" ADD COLUMN "failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "scheduled_messages" ADD COLUMN "failure" text;--> statement-breakpoint
ALTER TABLE "community_events" ADD CONSTRAINT "community_events_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_events" ADD CONSTRAINT "community_events_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_reminders" ADD CONSTRAINT "community_reminders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_reminders" ADD CONSTRAINT "community_reminders_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_reminders" ADD CONSTRAINT "community_reminders_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_reminders" ADD CONSTRAINT "community_reminders_event_id_community_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."community_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_event_responses" ADD CONSTRAINT "community_event_responses_event_id_community_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."community_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_event_responses" ADD CONSTRAINT "community_event_responses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_collections" ADD CONSTRAINT "saved_collections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_item_details" ADD CONSTRAINT "saved_item_details_collection_id_saved_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."saved_collections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_item_details" ADD CONSTRAINT "saved_item_details_user_id_message_id_saved_messages_user_id_message_id_fk" FOREIGN KEY ("user_id","message_id") REFERENCES "public"."saved_messages"("user_id","message_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_welcome_reads" ADD CONSTRAINT "community_welcome_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_welcome_reads" ADD CONSTRAINT "community_welcome_reads_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "community_events_room_time_idx" ON "community_events" USING btree ("conversation_id","starts_at");--> statement-breakpoint
CREATE INDEX "community_reminders_due_idx" ON "community_reminders" USING btree ("due_at");--> statement-breakpoint
CREATE INDEX "community_reminders_owner_idx" ON "community_reminders" USING btree ("user_id","due_at");--> statement-breakpoint
CREATE INDEX "saved_collections_owner_idx" ON "saved_collections" USING btree ("user_id");