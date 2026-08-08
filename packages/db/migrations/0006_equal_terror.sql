CREATE TABLE "device_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_code_hash" text NOT NULL,
	"poll_token_hash" text NOT NULL,
	"client_description" text NOT NULL,
	"request_ip" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"claimed_by_user_id" uuid,
	"claimed_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"attempts" text DEFAULT '0' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "device_grants" ADD CONSTRAINT "device_grants_claimed_by_user_id_users_id_fk" FOREIGN KEY ("claimed_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "device_grants_poll_uq" ON "device_grants" USING btree ("poll_token_hash");--> statement-breakpoint
CREATE INDEX "device_grants_code_idx" ON "device_grants" USING btree ("user_code_hash");--> statement-breakpoint
CREATE INDEX "device_grants_expiry_idx" ON "device_grants" USING btree ("expires_at");