ALTER TABLE "conversations" ADD COLUMN "is_board" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "card_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_card_key_uq" ON "messages" USING btree ("conversation_id","sender_id","card_key") WHERE "messages"."card_key" is not null;