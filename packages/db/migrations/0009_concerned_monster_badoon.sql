ALTER TABLE "users" ALTER COLUMN "notifications" SET DEFAULT '{"dm":"all","groups":"mentions","calls":true,"reactions":true,"showPreview":true,"sound":"default","quietHours":null,"announcements":true}'::jsonb;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "webhook_failure_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "webhook_last_failure_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "webhook_last_success_at" timestamp with time zone;