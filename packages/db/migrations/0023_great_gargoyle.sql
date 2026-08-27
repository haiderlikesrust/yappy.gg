CREATE TABLE "bot_event_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"application_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" text,
	"status" text NOT NULL,
	"http_status" integer,
	"duration_ms" integer,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bot_event_log" ADD CONSTRAINT "bot_event_log_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bot_event_log_app_idx" ON "bot_event_log" USING btree ("application_id","created_at" DESC NULLS LAST);