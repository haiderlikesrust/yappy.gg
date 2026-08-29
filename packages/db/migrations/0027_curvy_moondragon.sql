CREATE TABLE "message_envelopes" (
	"message_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"ciphertext" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_envelopes_message_id_device_id_pk" PRIMARY KEY("message_id","device_id")
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "is_encrypted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "message_envelopes" ADD CONSTRAINT "message_envelopes_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_envelopes" ADD CONSTRAINT "message_envelopes_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "envelopes_device_idx" ON "message_envelopes" USING btree ("device_id");