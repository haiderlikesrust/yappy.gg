CREATE TABLE "bug_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"reporter_id" uuid,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"reference" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"platform" text,
	"app_version" text,
	"os_version" text,
	"media_ids" uuid[] DEFAULT '{}' NOT NULL,
	"staff_message_id" uuid,
	"resolved_by_id" uuid,
	"resolved_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bug_reports" ADD CONSTRAINT "bug_reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bug_reports" ADD CONSTRAINT "bug_reports_resolved_by_id_users_id_fk" FOREIGN KEY ("resolved_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bug_reference_uq" ON "bug_reports" USING btree ("reference");--> statement-breakpoint
CREATE INDEX "bug_open_idx" ON "bug_reports" USING btree ("created_at" DESC NULLS LAST) WHERE "bug_reports"."status" = 'open';--> statement-breakpoint
CREATE INDEX "bug_reporter_idx" ON "bug_reports" USING btree ("reporter_id","status","created_at" DESC NULLS LAST);