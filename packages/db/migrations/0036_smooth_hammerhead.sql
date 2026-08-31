CREATE TABLE "conversation_apps" (
	"conversation_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"permissions" bigint DEFAULT 0 NOT NULL,
	"installed_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_apps_conversation_id_application_id_pk" PRIMARY KEY("conversation_id","application_id")
);
--> statement-breakpoint
ALTER TABLE "conversation_apps" ADD CONSTRAINT "conversation_apps_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_apps" ADD CONSTRAINT "conversation_apps_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_apps" ADD CONSTRAINT "conversation_apps_installed_by_id_users_id_fk" FOREIGN KEY ("installed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_apps_app_idx" ON "conversation_apps" USING btree ("application_id");