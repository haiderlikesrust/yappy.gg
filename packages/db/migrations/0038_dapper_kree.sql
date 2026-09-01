DROP INDEX "members_unread_idx";--> statement-breakpoint
DROP INDEX "reactions_message_idx";--> statement-breakpoint
CREATE INDEX "members_gating_idx" ON "conversation_members" USING btree ("conversation_id") WHERE "conversation_members"."deny" <> 0 or "conversation_members"."allow" <> 0 or "conversation_members"."role" = 'restricted';