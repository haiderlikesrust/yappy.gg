ALTER TABLE "conversation_members" ALTER COLUMN "notification_level" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "conversation_members" ALTER COLUMN "notification_level" DROP NOT NULL;--> statement-breakpoint
--> Channel rows are created automatically just to hold a read cursor, so an
--> 'all' on one is a default nobody chose — and under the new semantics that
--> default would masquerade as an override and stop the channel following its
--> space. Null them so they inherit. Safe to do unconditionally: per-channel
--> notification settings ship in this same change, so no deliberate value can
--> predate it.
UPDATE "conversation_members" cm
   SET "notification_level" = NULL
  FROM "conversations" c
 WHERE c.id = cm.conversation_id
   AND c.parent_id IS NOT NULL
   AND cm."notification_level" = 'all';