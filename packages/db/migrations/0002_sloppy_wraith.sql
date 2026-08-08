ALTER TABLE "users" ADD COLUMN "badge" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "affiliation_conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD COLUMN "is_affiliate" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "badge" text;--> statement-breakpoint
--> `badge` is the display truth and `is_verified` the boolean shorthand; anyone
--> already flagged verified keeps their mark rather than silently losing it.
UPDATE "users" SET "badge" = 'verified' WHERE "is_verified" AND "badge" IS NULL;