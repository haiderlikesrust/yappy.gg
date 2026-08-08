CREATE TYPE "public"."call_participant_state" AS ENUM('invited', 'ringing', 'joined', 'left', 'declined', 'missed', 'busy');--> statement-breakpoint
CREATE TYPE "public"."call_state" AS ENUM('ringing', 'active', 'ended');--> statement-breakpoint
CREATE TYPE "public"."conversation_type" AS ENUM('dm', 'group', 'channel');--> statement-breakpoint
CREATE TYPE "public"."media_status" AS ENUM('pending', 'processing', 'ready', 'failed', 'quarantined');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('owner', 'admin', 'moderator', 'member', 'restricted');--> statement-breakpoint
CREATE TYPE "public"."message_type" AS ENUM('text', 'image', 'video', 'audio', 'file', 'sticker', 'gif', 'location', 'contact', 'poll', 'call', 'system');--> statement-breakpoint
CREATE TYPE "public"."notification_level" AS ENUM('all', 'mentions', 'none');--> statement-breakpoint
CREATE TYPE "public"."platform" AS ENUM('ios', 'android', 'web', 'desktop');--> statement-breakpoint
CREATE TYPE "public"."presence_status" AS ENUM('online', 'idle', 'dnd', 'offline');--> statement-breakpoint
CREATE TYPE "public"."privacy_audience" AS ENUM('everyone', 'contacts', 'nobody');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('open', 'reviewing', 'actioned', 'dismissed');--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text,
	"platform" text NOT NULL,
	"app_version" text,
	"os_version" text,
	"refresh_token_hash" text,
	"previous_refresh_token_hash" text,
	"previous_refresh_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"push_token" text,
	"voip_token" text,
	"push_environment" text DEFAULT 'production' NOT NULL,
	"push_failure_count" integer DEFAULT 0 NOT NULL,
	"last_ip" text,
	"last_user_agent" text,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_identities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"subject" text NOT NULL,
	"email" "citext",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "otp_challenges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"identifier" "citext" NOT NULL,
	"channel" text NOT NULL,
	"purpose" text NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"consumed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"request_ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"username" "citext",
	"display_name" text,
	"bio" text,
	"pronouns" text,
	"birthday" text,
	"avatar_media_id" uuid,
	"banner_media_id" uuid,
	"phone" text,
	"phone_verified_at" timestamp with time zone,
	"email" "citext",
	"email_verified_at" timestamp with time zone,
	"phone_hash" text,
	"password_hash" text,
	"presence_status" "presence_status" DEFAULT 'offline' NOT NULL,
	"custom_status" text,
	"custom_status_expires_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"privacy" jsonb DEFAULT '{"whoCanDm":"everyone","whoCanAddToGroups":"contacts","whoCanSeeLastSeen":"contacts","whoCanSeeAvatar":"everyone","whoCanCall":"contacts","readReceipts":true,"typingIndicators":true,"discoverableByPhone":true,"discoverableByUsername":true}'::jsonb NOT NULL,
	"notifications" jsonb DEFAULT '{"dm":"all","groups":"mentions","calls":true,"reactions":true,"showPreview":true,"sound":"default","quietHours":null}'::jsonb NOT NULL,
	"appearance" jsonb DEFAULT '{"theme":"system","accent":"#6C5CE7","fontScale":1,"reduceMotion":false}'::jsonb NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"is_bot" boolean DEFAULT false NOT NULL,
	"is_verified" boolean DEFAULT false NOT NULL,
	"suspended_until" timestamp with time zone,
	"suspension_reason" text,
	"token_epoch" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "blocks" (
	"blocker_id" uuid NOT NULL,
	"blocked_id" uuid NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blocks_blocker_id_blocked_id_pk" PRIMARY KEY("blocker_id","blocked_id")
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"owner_id" uuid NOT NULL,
	"user_id" uuid,
	"phone_hash" text NOT NULL,
	"local_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_owner_id_phone_hash_pk" PRIMARY KEY("owner_id","phone_hash")
);
--> statement-breakpoint
CREATE TABLE "follows" (
	"follower_id" uuid NOT NULL,
	"followee_id" uuid NOT NULL,
	"is_mutual" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "follows_follower_id_followee_id_pk" PRIMARY KEY("follower_id","followee_id")
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"code" text NOT NULL,
	"created_by_id" uuid NOT NULL,
	"max_uses" integer DEFAULT 0 NOT NULL,
	"uses" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "presence" (
	"device_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"node_id" text NOT NULL,
	"status" text DEFAULT 'online' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"subject" text NOT NULL,
	"action" text NOT NULL,
	"tokens" double precision DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "rate_limits_subject_action_pk" PRIMARY KEY("subject","action")
);
--> statement-breakpoint
CREATE TABLE "conversation_bans" (
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"banned_by_id" uuid,
	"reason" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_bans_conversation_id_user_id_pk" PRIMARY KEY("conversation_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "conversation_members" (
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "member_role" DEFAULT 'member' NOT NULL,
	"allow" bigint DEFAULT 0 NOT NULL,
	"deny" bigint DEFAULT 0 NOT NULL,
	"muted_until" timestamp with time zone,
	"nickname" text,
	"last_read_seq" bigint DEFAULT 0 NOT NULL,
	"last_read_at" timestamp with time zone,
	"last_delivered_seq" bigint DEFAULT 0 NOT NULL,
	"mention_count" integer DEFAULT 0 NOT NULL,
	"notification_level" "notification_level" DEFAULT 'all' NOT NULL,
	"is_pinned" boolean DEFAULT false NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"draft" text,
	"draft_updated_at" timestamp with time zone,
	"history_start_seq" bigint DEFAULT 0 NOT NULL,
	"invited_by_id" uuid,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	CONSTRAINT "conversation_members_conversation_id_user_id_pk" PRIMARY KEY("conversation_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" "conversation_type" NOT NULL,
	"title" text,
	"description" text,
	"avatar_media_id" uuid,
	"owner_id" uuid,
	"created_by_id" uuid,
	"dm_key" text,
	"message_seq" bigint DEFAULT 0 NOT NULL,
	"last_message_id" uuid,
	"last_message_at" timestamp with time zone,
	"last_message_preview" text,
	"last_message_sender_id" uuid,
	"member_count" integer DEFAULT 0 NOT NULL,
	"base_permissions" bigint,
	"disappearing_seconds" integer DEFAULT 0 NOT NULL,
	"slow_mode_seconds" integer DEFAULT 0 NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"handle" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "link_previews" (
	"url_hash" text PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"title" text,
	"description" text,
	"site_name" text,
	"image_media_id" uuid,
	"embed_html" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"failed" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_attachments" (
	"message_id" uuid NOT NULL,
	"media_id" uuid NOT NULL,
	"position" smallint DEFAULT 0 NOT NULL,
	"caption" text,
	"is_spoiler" boolean DEFAULT false NOT NULL,
	CONSTRAINT "message_attachments_message_id_media_id_pk" PRIMARY KEY("message_id","media_id")
);
--> statement-breakpoint
CREATE TABLE "message_deletions" (
	"message_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_deletions_message_id_user_id_pk" PRIMARY KEY("message_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "message_mentions" (
	"message_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"is_broadcast" boolean DEFAULT false NOT NULL,
	CONSTRAINT "message_mentions_message_id_user_id_pk" PRIMARY KEY("message_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "message_previews" (
	"message_id" uuid NOT NULL,
	"url_hash" text NOT NULL,
	CONSTRAINT "message_previews_message_id_url_hash_pk" PRIMARY KEY("message_id","url_hash")
);
--> statement-breakpoint
CREATE TABLE "message_reactions" (
	"message_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"emoji" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_reactions_message_id_user_id_emoji_pk" PRIMARY KEY("message_id","user_id","emoji")
);
--> statement-breakpoint
CREATE TABLE "message_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"message_id" uuid NOT NULL,
	"content" text,
	"entities" jsonb,
	"edited_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"sender_id" uuid,
	"type" "message_type" DEFAULT 'text' NOT NULL,
	"content" text,
	"entities" jsonb,
	"reply_to_id" uuid,
	"thread_root_id" uuid,
	"thread_reply_count" integer DEFAULT 0 NOT NULL,
	"forwarded_from_message_id" uuid,
	"forwarded_from_user_id" uuid,
	"sticker_id" uuid,
	"gif" jsonb,
	"location" jsonb,
	"contact" jsonb,
	"call_summary" jsonb,
	"system" jsonb,
	"nonce" text,
	"edited_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"silent" boolean DEFAULT false NOT NULL,
	"reaction_counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"deleted_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pinned_messages" (
	"conversation_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"pinned_by_id" uuid,
	"position" integer DEFAULT 0 NOT NULL,
	"pinned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pinned_messages_conversation_id_message_id_pk" PRIMARY KEY("conversation_id","message_id")
);
--> statement-breakpoint
CREATE TABLE "poll_options" (
	"id" uuid PRIMARY KEY NOT NULL,
	"poll_id" uuid NOT NULL,
	"label" text NOT NULL,
	"position" smallint NOT NULL,
	"vote_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "poll_votes" (
	"poll_id" uuid NOT NULL,
	"option_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "poll_votes_option_id_user_id_pk" PRIMARY KEY("option_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "polls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"message_id" uuid NOT NULL,
	"question" text NOT NULL,
	"multi_select" boolean DEFAULT false NOT NULL,
	"is_anonymous" boolean DEFAULT false NOT NULL,
	"closes_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"total_voters" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "polls_message_id_unique" UNIQUE("message_id")
);
--> statement-breakpoint
CREATE TABLE "scheduled_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"send_at" timestamp with time zone NOT NULL,
	"sent_message_id" uuid,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid,
	"purpose" text NOT NULL,
	"status" "media_status" DEFAULT 'pending' NOT NULL,
	"bucket" text NOT NULL,
	"object_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"size" bigint DEFAULT 0 NOT NULL,
	"filename" text,
	"width" integer,
	"height" integer,
	"duration_ms" integer,
	"blurhash" text,
	"waveform" jsonb,
	"thumbnail_key" text,
	"variants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"checksum" text,
	"moderation_labels" jsonb,
	"scanned_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"ref_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "favorite_gifs" (
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_id" text NOT NULL,
	"url" text NOT NULL,
	"preview_url" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "favorite_gifs_user_id_provider_provider_id_pk" PRIMARY KEY("user_id","provider","provider_id")
);
--> statement-breakpoint
CREATE TABLE "recent_items" (
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"item_key" text NOT NULL,
	"payload" text,
	"use_count" integer DEFAULT 1 NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recent_items_user_id_kind_item_key_pk" PRIMARY KEY("user_id","kind","item_key")
);
--> statement-breakpoint
CREATE TABLE "sticker_packs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" "citext" NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"author_id" uuid,
	"cover_media_id" uuid,
	"is_animated" boolean DEFAULT false NOT NULL,
	"is_official" boolean DEFAULT false NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"install_count" integer DEFAULT 0 NOT NULL,
	"sticker_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "stickers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"pack_id" uuid NOT NULL,
	"media_id" uuid NOT NULL,
	"emoji" text NOT NULL,
	"name" text,
	"position" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user_sticker_packs" (
	"user_id" uuid NOT NULL,
	"pack_id" uuid NOT NULL,
	"position" smallint DEFAULT 0 NOT NULL,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_sticker_packs_user_id_pack_id_pk" PRIMARY KEY("user_id","pack_id")
);
--> statement-breakpoint
CREATE TABLE "call_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"call_id" uuid NOT NULL,
	"actor_id" uuid,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "call_participants" (
	"call_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"state" "call_participant_state" DEFAULT 'invited' NOT NULL,
	"device_id" uuid,
	"is_muted" boolean DEFAULT false NOT NULL,
	"is_video_enabled" boolean DEFAULT false NOT NULL,
	"is_screen_sharing" boolean DEFAULT false NOT NULL,
	"is_host" boolean DEFAULT false NOT NULL,
	"joined_at" timestamp with time zone,
	"left_at" timestamp with time zone,
	"total_seconds" integer DEFAULT 0 NOT NULL,
	"connection_quality" text,
	"invited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "call_participants_call_id_user_id_pk" PRIMARY KEY("call_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid,
	"initiator_id" uuid,
	"mode" text DEFAULT 'audio' NOT NULL,
	"state" "call_state" DEFAULT 'ringing' NOT NULL,
	"room_name" text NOT NULL,
	"region" text,
	"nonce" text,
	"max_participants" integer DEFAULT 32 NOT NULL,
	"peak_participants" integer DEFAULT 0 NOT NULL,
	"ring_expires_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"duration_seconds" integer,
	"recording_media_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"action" text NOT NULL,
	"ip" text,
	"user_agent" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "moderation_actions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"moderator_id" uuid,
	"report_id" uuid,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"reason" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"reporter_id" uuid,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"detail" text,
	"evidence" jsonb,
	"status" "report_status" DEFAULT 'open' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"assigned_to_id" uuid,
	"resolution" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crypto_identities" (
	"device_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"identity_key" text NOT NULL,
	"signed_pre_key_id" integer NOT NULL,
	"signed_pre_key" text NOT NULL,
	"signed_pre_key_signature" text NOT NULL,
	"signed_pre_key_rotated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "key_verifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"verifier_id" uuid NOT NULL,
	"verified_user_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"is_valid" boolean DEFAULT true NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "one_time_pre_keys" (
	"device_id" uuid NOT NULL,
	"key_id" integer NOT NULL,
	"public_key" text NOT NULL,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "one_time_pre_keys_device_id_key_id_pk" PRIMARY KEY("device_id","key_id")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"actor_id" uuid,
	"target_type" text,
	"target_id" uuid,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"group_key" text,
	"count" integer DEFAULT 1 NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" uuid,
	"kind" text NOT NULL,
	"collapse_key" text,
	"dedupe_key" text,
	"title" text,
	"body" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"badge" integer,
	"sound" text,
	"priority" text DEFAULT 'high' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"expires_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bus_overflow" (
	"id" uuid PRIMARY KEY NOT NULL,
	"topic" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_identities" ADD CONSTRAINT "oauth_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blocker_id_users_id_fk" FOREIGN KEY ("blocker_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blocked_id_users_id_fk" FOREIGN KEY ("blocked_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_follower_id_users_id_fk" FOREIGN KEY ("follower_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_followee_id_users_id_fk" FOREIGN KEY ("followee_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presence" ADD CONSTRAINT "presence_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presence" ADD CONSTRAINT "presence_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_bans" ADD CONSTRAINT "conversation_bans_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_bans" ADD CONSTRAINT "conversation_bans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_bans" ADD CONSTRAINT "conversation_bans_banned_by_id_users_id_fk" FOREIGN KEY ("banned_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_invited_by_id_users_id_fk" FOREIGN KEY ("invited_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_previews" ADD CONSTRAINT "link_previews_image_media_id_media_id_fk" FOREIGN KEY ("image_media_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_deletions" ADD CONSTRAINT "message_deletions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_deletions" ADD CONSTRAINT "message_deletions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_mentions" ADD CONSTRAINT "message_mentions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_mentions" ADD CONSTRAINT "message_mentions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_mentions" ADD CONSTRAINT "message_mentions_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_previews" ADD CONSTRAINT "message_previews_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_previews" ADD CONSTRAINT "message_previews_url_hash_link_previews_url_hash_fk" FOREIGN KEY ("url_hash") REFERENCES "public"."link_previews"("url_hash") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_revisions" ADD CONSTRAINT "message_revisions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_reply_to_id_messages_id_fk" FOREIGN KEY ("reply_to_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_root_id_messages_id_fk" FOREIGN KEY ("thread_root_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_forwarded_from_user_id_users_id_fk" FOREIGN KEY ("forwarded_from_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sticker_id_stickers_id_fk" FOREIGN KEY ("sticker_id") REFERENCES "public"."stickers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_deleted_by_id_users_id_fk" FOREIGN KEY ("deleted_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pinned_messages" ADD CONSTRAINT "pinned_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pinned_messages" ADD CONSTRAINT "pinned_messages_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pinned_messages" ADD CONSTRAINT "pinned_messages_pinned_by_id_users_id_fk" FOREIGN KEY ("pinned_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_options" ADD CONSTRAINT "poll_options_poll_id_polls_id_fk" FOREIGN KEY ("poll_id") REFERENCES "public"."polls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_poll_id_polls_id_fk" FOREIGN KEY ("poll_id") REFERENCES "public"."polls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_option_id_poll_options_id_fk" FOREIGN KEY ("option_id") REFERENCES "public"."poll_options"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "polls" ADD CONSTRAINT "polls_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_messages" ADD CONSTRAINT "scheduled_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_messages" ADD CONSTRAINT "scheduled_messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_messages" ADD CONSTRAINT "scheduled_messages_sent_message_id_messages_id_fk" FOREIGN KEY ("sent_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favorite_gifs" ADD CONSTRAINT "favorite_gifs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recent_items" ADD CONSTRAINT "recent_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sticker_packs" ADD CONSTRAINT "sticker_packs_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sticker_packs" ADD CONSTRAINT "sticker_packs_cover_media_id_media_id_fk" FOREIGN KEY ("cover_media_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stickers" ADD CONSTRAINT "stickers_pack_id_sticker_packs_id_fk" FOREIGN KEY ("pack_id") REFERENCES "public"."sticker_packs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stickers" ADD CONSTRAINT "stickers_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sticker_packs" ADD CONSTRAINT "user_sticker_packs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sticker_packs" ADD CONSTRAINT "user_sticker_packs_pack_id_sticker_packs_id_fk" FOREIGN KEY ("pack_id") REFERENCES "public"."sticker_packs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_events" ADD CONSTRAINT "call_events_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_events" ADD CONSTRAINT "call_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_participants" ADD CONSTRAINT "call_participants_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_participants" ADD CONSTRAINT "call_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_participants" ADD CONSTRAINT "call_participants_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_initiator_id_users_id_fk" FOREIGN KEY ("initiator_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_moderator_id_users_id_fk" FOREIGN KEY ("moderator_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_assigned_to_id_users_id_fk" FOREIGN KEY ("assigned_to_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crypto_identities" ADD CONSTRAINT "crypto_identities_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crypto_identities" ADD CONSTRAINT "crypto_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "key_verifications" ADD CONSTRAINT "key_verifications_verifier_id_users_id_fk" FOREIGN KEY ("verifier_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "key_verifications" ADD CONSTRAINT "key_verifications_verified_user_id_users_id_fk" FOREIGN KEY ("verified_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "one_time_pre_keys" ADD CONSTRAINT "one_time_pre_keys_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_outbox" ADD CONSTRAINT "push_outbox_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_outbox" ADD CONSTRAINT "push_outbox_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "devices_user_idx" ON "devices" USING btree ("user_id") WHERE "devices"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "devices_refresh_uq" ON "devices" USING btree ("refresh_token_hash");--> statement-breakpoint
CREATE INDEX "devices_push_token_idx" ON "devices" USING btree ("push_token") WHERE "devices"."push_token" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_provider_subject_uq" ON "oauth_identities" USING btree ("provider","subject");--> statement-breakpoint
CREATE INDEX "oauth_user_idx" ON "oauth_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "otp_identifier_idx" ON "otp_challenges" USING btree ("identifier","purpose") WHERE "otp_challenges"."consumed_at" is null;--> statement-breakpoint
CREATE INDEX "otp_expires_idx" ON "otp_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_uq" ON "users" USING btree ("username") WHERE "users"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "users_phone_uq" ON "users" USING btree ("phone") WHERE "users"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree ("email") WHERE "users"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "users_phone_hash_idx" ON "users" USING btree ("phone_hash") WHERE "users"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "users_search_idx" ON "users" USING gin ((coalesce("username", '') || ' ' || coalesce("display_name", '')) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "users_last_seen_idx" ON "users" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "blocks_blocked_idx" ON "blocks" USING btree ("blocked_id");--> statement-breakpoint
CREATE INDEX "contacts_user_idx" ON "contacts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "follows_followee_idx" ON "follows" USING btree ("followee_id");--> statement-breakpoint
CREATE INDEX "follows_mutual_idx" ON "follows" USING btree ("follower_id") WHERE "follows"."is_mutual";--> statement-breakpoint
CREATE UNIQUE INDEX "invites_code_uq" ON "invites" USING btree ("code");--> statement-breakpoint
CREATE INDEX "invites_conversation_idx" ON "invites" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "presence_user_idx" ON "presence" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "presence_expires_idx" ON "presence" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "presence_node_idx" ON "presence" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "rate_limits_expires_idx" ON "rate_limits" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "members_user_active_idx" ON "conversation_members" USING btree ("user_id","is_pinned" DESC NULLS LAST,"is_archived") WHERE "conversation_members"."left_at" is null;--> statement-breakpoint
CREATE INDEX "members_conversation_idx" ON "conversation_members" USING btree ("conversation_id") WHERE "conversation_members"."left_at" is null;--> statement-breakpoint
CREATE INDEX "members_unread_idx" ON "conversation_members" USING btree ("user_id","last_read_seq") WHERE "conversation_members"."left_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_dm_key_uq" ON "conversations" USING btree ("dm_key") WHERE "conversations"."dm_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_handle_uq" ON "conversations" USING btree ("handle") WHERE "conversations"."handle" is not null;--> statement-breakpoint
CREATE INDEX "conversations_last_message_idx" ON "conversations" USING btree ("last_message_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "conversations_public_idx" ON "conversations" USING btree ("type","last_message_at" DESC NULLS LAST) WHERE "conversations"."is_public" and "conversations"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "link_previews_expires_idx" ON "link_previews" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "attachments_media_idx" ON "message_attachments" USING btree ("media_id");--> statement-breakpoint
CREATE INDEX "mentions_inbox_idx" ON "message_mentions" USING btree ("user_id","conversation_id","seq");--> statement-breakpoint
CREATE INDEX "reactions_message_idx" ON "message_reactions" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "reactions_user_idx" ON "message_reactions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "revisions_message_idx" ON "message_revisions" USING btree ("message_id","edited_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "messages_conversation_seq_uq" ON "messages" USING btree ("conversation_id","seq");--> statement-breakpoint
CREATE INDEX "messages_conversation_created_idx" ON "messages" USING btree ("conversation_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "messages_sender_nonce_uq" ON "messages" USING btree ("sender_id","nonce") WHERE "messages"."nonce" is not null;--> statement-breakpoint
CREATE INDEX "messages_thread_idx" ON "messages" USING btree ("thread_root_id","seq") WHERE "messages"."thread_root_id" is not null;--> statement-breakpoint
CREATE INDEX "messages_reply_idx" ON "messages" USING btree ("reply_to_id") WHERE "messages"."reply_to_id" is not null;--> statement-breakpoint
CREATE INDEX "messages_expires_idx" ON "messages" USING btree ("expires_at") WHERE "messages"."expires_at" is not null and "messages"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "messages_type_idx" ON "messages" USING btree ("conversation_id","type","seq" DESC NULLS LAST) WHERE "messages"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "pins_conversation_idx" ON "pinned_messages" USING btree ("conversation_id","position","pinned_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "poll_options_poll_idx" ON "poll_options" USING btree ("poll_id","position");--> statement-breakpoint
CREATE INDEX "poll_votes_poll_user_idx" ON "poll_votes" USING btree ("poll_id","user_id");--> statement-breakpoint
CREATE INDEX "scheduled_due_idx" ON "scheduled_messages" USING btree ("send_at") WHERE "scheduled_messages"."sent_message_id" is null and "scheduled_messages"."cancelled_at" is null;--> statement-breakpoint
CREATE INDEX "scheduled_user_idx" ON "scheduled_messages" USING btree ("sender_id","send_at");--> statement-breakpoint
CREATE INDEX "media_owner_idx" ON "media" USING btree ("owner_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "media_checksum_idx" ON "media" USING btree ("checksum") WHERE "media"."checksum" is not null;--> statement-breakpoint
CREATE INDEX "media_orphan_idx" ON "media" USING btree ("created_at") WHERE "media"."confirmed_at" is null;--> statement-breakpoint
CREATE INDEX "media_gc_idx" ON "media" USING btree ("ref_count") WHERE "media"."ref_count" = 0 and "media"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "recent_items_lookup_idx" ON "recent_items" USING btree ("user_id","kind","last_used_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "sticker_packs_slug_uq" ON "sticker_packs" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "sticker_packs_store_idx" ON "sticker_packs" USING btree ("install_count" DESC NULLS LAST) WHERE "sticker_packs"."is_public" and "sticker_packs"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "sticker_packs_author_idx" ON "sticker_packs" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "stickers_pack_idx" ON "stickers" USING btree ("pack_id","position");--> statement-breakpoint
CREATE INDEX "stickers_emoji_idx" ON "stickers" USING btree ("emoji");--> statement-breakpoint
CREATE INDEX "user_packs_order_idx" ON "user_sticker_packs" USING btree ("user_id","position");--> statement-breakpoint
CREATE INDEX "call_events_call_idx" ON "call_events" USING btree ("call_id","created_at");--> statement-breakpoint
CREATE INDEX "call_participants_user_idx" ON "call_participants" USING btree ("user_id","invited_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "call_participants_active_idx" ON "call_participants" USING btree ("call_id") WHERE "call_participants"."state" = 'joined';--> statement-breakpoint
CREATE UNIQUE INDEX "calls_room_uq" ON "calls" USING btree ("room_name");--> statement-breakpoint
CREATE UNIQUE INDEX "calls_initiator_nonce_uq" ON "calls" USING btree ("initiator_id","nonce") WHERE "calls"."nonce" is not null;--> statement-breakpoint
CREATE INDEX "calls_conversation_idx" ON "calls" USING btree ("conversation_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "calls_active_idx" ON "calls" USING btree ("conversation_id") WHERE "calls"."state" <> 'ended';--> statement-breakpoint
CREATE INDEX "calls_ring_timeout_idx" ON "calls" USING btree ("ring_expires_at") WHERE "calls"."state" = 'ringing';--> statement-breakpoint
CREATE INDEX "audit_user_idx" ON "audit_log" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "mod_actions_target_idx" ON "moderation_actions" USING btree ("target_type","target_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "mod_actions_moderator_idx" ON "moderation_actions" USING btree ("moderator_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "reports_queue_idx" ON "reports" USING btree ("priority" DESC NULLS LAST,"created_at") WHERE "reports"."status" = 'open';--> statement-breakpoint
CREATE INDEX "reports_target_idx" ON "reports" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "reports_reporter_idx" ON "reports" USING btree ("reporter_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "crypto_identities_user_idx" ON "crypto_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "key_verifications_pair_idx" ON "key_verifications" USING btree ("verifier_id","verified_user_id");--> statement-breakpoint
CREATE INDEX "otpk_available_idx" ON "one_time_pre_keys" USING btree ("device_id") WHERE "one_time_pre_keys"."claimed_at" is null;--> statement-breakpoint
CREATE INDEX "notifications_inbox_idx" ON "notifications" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("user_id") WHERE "notifications"."read_at" is null;--> statement-breakpoint
CREATE INDEX "notifications_group_idx" ON "notifications" USING btree ("user_id","group_key") WHERE "notifications"."group_key" is not null;--> statement-breakpoint
CREATE INDEX "push_outbox_pending_idx" ON "push_outbox" USING btree ("created_at") WHERE "push_outbox"."sent_at" is null;--> statement-breakpoint
CREATE INDEX "push_outbox_user_idx" ON "push_outbox" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "push_outbox_dedupe_idx" ON "push_outbox" USING btree ("dedupe_key") WHERE "push_outbox"."dedupe_key" is not null;--> statement-breakpoint
CREATE INDEX "bus_overflow_expires_idx" ON "bus_overflow" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "event_log_replay_idx" ON "event_log" USING btree ("user_id","id");--> statement-breakpoint
CREATE INDEX "event_log_expires_idx" ON "event_log" USING btree ("expires_at");