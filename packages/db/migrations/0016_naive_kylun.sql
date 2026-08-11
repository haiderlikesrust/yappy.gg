CREATE TABLE "early_claims" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"wallet_address" text,
	"amount_usd" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"submitted_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"tx_signature" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "early_claims" ADD CONSTRAINT "early_claims_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "early_claim_user_uq" ON "early_claims" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "early_claim_open_idx" ON "early_claims" USING btree ("status","expires_at");