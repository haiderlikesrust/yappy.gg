CREATE TABLE "support_tickets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"reference" text NOT NULL,
	"request_id" uuid NOT NULL,
	"payload_hash" text NOT NULL,
	"category" text NOT NULL,
	"contact_email" text NOT NULL,
	"account_hint" text,
	"message" text NOT NULL,
	"verified_user_id" uuid,
	"report_id" uuid,
	"client" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_verified_user_id_users_id_fk" FOREIGN KEY ("verified_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "support_ticket_reference_uq" ON "support_tickets" USING btree ("reference");--> statement-breakpoint
CREATE UNIQUE INDEX "support_ticket_request_uq" ON "support_tickets" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "support_ticket_account_idx" ON "support_tickets" USING btree ("verified_user_id","created_at");