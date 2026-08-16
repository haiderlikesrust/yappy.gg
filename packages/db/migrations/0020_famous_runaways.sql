CREATE TABLE "group_pets" (
	"conversation_id" uuid PRIMARY KEY NOT NULL,
	"name" text,
	"fed_days" integer DEFAULT 0 NOT NULL,
	"streak" integer DEFAULT 0 NOT NULL,
	"last_fed_on" text,
	"wandered_at" timestamp with time zone,
	"born_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "group_pets" ADD CONSTRAINT "group_pets_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;