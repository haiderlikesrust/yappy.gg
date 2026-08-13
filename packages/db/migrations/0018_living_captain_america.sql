CREATE TABLE "verification_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"requester_id" uuid,
	"purpose" text NOT NULL,
	"link" text,
	"note" text,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "verification_requests" ADD CONSTRAINT "verification_requests_requester_id_users_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "verification_open_uq" ON "verification_requests" USING btree ("conversation_id") WHERE status = 'open';--> statement-breakpoint
CREATE INDEX "verification_status_idx" ON "verification_requests" USING btree ("status");