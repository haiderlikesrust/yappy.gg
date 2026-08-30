CREATE TABLE "conversation_role_overwrites" (
	"conversation_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"allow" bigint DEFAULT 0 NOT NULL,
	"deny" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_role_overwrites_conversation_id_role_id_pk" PRIMARY KEY("conversation_id","role_id")
);
--> statement-breakpoint
ALTER TABLE "conversation_role_overwrites" ADD CONSTRAINT "conversation_role_overwrites_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_role_overwrites" ADD CONSTRAINT "conversation_role_overwrites_role_id_conversation_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."conversation_roles"("id") ON DELETE cascade ON UPDATE no action;