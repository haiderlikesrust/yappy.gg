CREATE TABLE "conversation_roles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"permissions" bigint DEFAULT 0 NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"is_hoisted" boolean DEFAULT false NOT NULL,
	"is_mentionable" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member_roles" (
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"assigned_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_roles_conversation_id_user_id_role_id_pk" PRIMARY KEY("conversation_id","user_id","role_id")
);
--> statement-breakpoint
ALTER TABLE "conversation_roles" ADD CONSTRAINT "conversation_roles_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_roles" ADD CONSTRAINT "member_roles_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_roles" ADD CONSTRAINT "member_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_roles" ADD CONSTRAINT "member_roles_role_id_conversation_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."conversation_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_roles" ADD CONSTRAINT "member_roles_assigned_by_id_users_id_fk" FOREIGN KEY ("assigned_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "roles_conversation_idx" ON "conversation_roles" USING btree ("conversation_id","position" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "roles_conversation_name_uq" ON "conversation_roles" USING btree ("conversation_id",lower("name"));--> statement-breakpoint
CREATE INDEX "member_roles_role_idx" ON "member_roles" USING btree ("role_id");