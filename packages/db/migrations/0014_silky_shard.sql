ALTER TABLE "users" ADD COLUMN "badges" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
-- Everyone who already holds a badge keeps it, in the new shape. Without this
-- the array starts empty for every existing holder and the two columns
-- disagree from the moment the column exists.
UPDATE "users" SET "badges" = ARRAY["badge"] WHERE "badge" IS NOT NULL;
