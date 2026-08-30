import { useEffect, useState } from 'react';
import type { SVGProps } from 'react';
import {
  ALL_PERMISSIONS,
  DEFAULT_CONVERSATION_PERMISSIONS,
  Permission,
  ROLE_PERMISSIONS,
  has,
  type MemberRole,
  type PermissionName,
} from '@yappy/shared';
import { api } from '../../lib/api';
import type { Conversation } from '../../lib/types';

/**
 * Shared plumbing for the group admin surfaces: permission math, the media
 * upload pipeline for non-attachment purposes, campfire countdowns, and the
 * few glyphs the global icon set does not carry yet — drawn here in the same
 * voice (24px grid, 1.8px strokes, round caps, currentColor).
 */

// ─── Extra glyphs ────────────────────────────────────────────────────────────

export type GlyphName =
  | 'flame'
  | 'ban'
  | 'clock'
  | 'hourglass'
  | 'swap'
  | 'palette'
  | 'eye'
  | 'upload'
  | 'bag'
  | 'grid';

const GLYPHS: Record<GlyphName, JSX.Element> = {
  flame: (
    <path d="M12 3.8c2.9 2.7 5 5.5 5 8.4a5 5 0 0 1-10 0c0-1.1.3-2.1.9-3.2.5 1 1.2 1.7 2.2 1.9-.3-2.4.5-5 1.9-7.1ZM12 17.5c-1.4 0-2.4-1-2.4-2.3 0-1 .8-2.1 2.4-3.4 1.6 1.3 2.4 2.4 2.4 3.4 0 1.3-1 2.3-2.4 2.3Z" />
  ),
  ban: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M6.2 6.2 17.8 17.8" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  hourglass: (
    <path d="M7 4.5h10M7 19.5h10M8.2 4.5v2.4c0 2.2 3.8 3.4 3.8 5.1s-3.8 2.9-3.8 5.1v2.4M15.8 4.5v2.4c0 2.2-3.8 3.4-3.8 5.1s3.8 2.9 3.8 5.1v2.4" />
  ),
  swap: (
    <path d="M6.5 8h11m0 0L14 4.5M17.5 8 14 11.5M17.5 16h-11m0 0L10 12.5M6.5 16l3.5 3.5" />
  ),
  palette: (
    <>
      <path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.9-.7 1.9-1.6 0-.9-.7-1.3-.7-2.1 0-.9.7-1.6 1.8-1.6h1.8c2.1 0 3.7-1.5 3.7-3.6 0-4.5-3.8-8.1-8.5-8.1Z" />
      <path d="M8.1 9h.01M12 6.9h.01M15.9 9h.01M7.4 13.3h.01" strokeWidth="2.4" />
    </>
  ),
  eye: (
    <>
      <path d="M3.5 12c2.2-4 5-6 8.5-6s6.3 2 8.5 6c-2.2 4-5 6-8.5 6s-6.3-2-8.5-6Z" />
      <circle cx="12" cy="12" r="2.5" />
    </>
  ),
  upload: <path d="M12 15.5V5m0 0 4 4m-4-4-4 4M5 19.5h14" />,
  bag: (
    <path d="M6.5 8.5h11l-.9 9.9a2 2 0 0 1-2 1.8H9.4a2 2 0 0 1-2-1.8l-.9-9.9ZM9 8.5V7a3 3 0 0 1 6 0v1.5" />
  ),
  grid: (
    <>
      <rect x="4" y="4" width="7" height="7" rx="2" />
      <rect x="13" y="4" width="7" height="7" rx="2" />
      <rect x="4" y="13" width="7" height="7" rx="2" />
      <rect x="13" y="13" width="7" height="7" rx="2" />
    </>
  ),
};

export function Glyph(
  props: { name: GlyphName; size?: number } & Omit<SVGProps<SVGSVGElement>, 'name'>,
) {
  const { name, size = 20, ...rest } = props;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...rest}
    >
      {GLYPHS[name]}
    </svg>
  );
}

// ─── Permissions ─────────────────────────────────────────────────────────────

export { Permission, has };

/**
 * What the viewer may do here, as a bitfield.
 *
 * The conversation view carries `permissions` (a decimal string of the
 * viewer's effective bits, serialize.ts:530); the list payload may not, so
 * the ladder-role fallback mirrors effectivePermissions() for a plain group.
 */
export function effectivePerms(conversation: Conversation, myRole: string | null): bigint {
  const wire = (conversation as { permissions?: string | null }).permissions;
  if (wire) {
    try {
      return BigInt(wire);
    } catch {
      /* malformed — fall through to the ladder */
    }
  }
  const role = (myRole ?? 'member') as MemberRole;
  if (role === 'owner') return ALL_PERMISSIONS;
  const perms = DEFAULT_CONVERSATION_PERMISSIONS.group | (ROLE_PERMISSIONS[role] ?? 0n);
  return has(perms, Permission.ADMINISTRATOR) ? ALL_PERMISSIONS : perms;
}

/** The role editor's checkbox layout — every grantable bit, grouped sensibly. */
export const PERM_GROUPS: Array<{
  label: string;
  perms: Array<{ name: PermissionName; label: string }>;
}> = [
  {
    label: 'General',
    perms: [
      { name: 'VIEW_CONVERSATION', label: 'View the group' },
      { name: 'READ_HISTORY', label: 'Read history' },
      { name: 'INVITE_MEMBERS', label: 'Invite people' },
      { name: 'MANAGE_INVITES', label: 'Manage invites' },
      { name: 'MANAGE_CONVERSATION', label: 'Manage the group' },
      { name: 'MANAGE_ROLES', label: 'Manage roles' },
      { name: 'MANAGE_STICKERS', label: 'Manage emoji & stickers' },
      { name: 'ADMINISTRATOR', label: 'Administrator (everything)' },
    ],
  },
  {
    label: 'Messages',
    perms: [
      { name: 'SEND_MESSAGES', label: 'Send messages' },
      { name: 'SEND_MEDIA', label: 'Send media' },
      { name: 'SEND_VOICE_NOTES', label: 'Send voice notes' },
      { name: 'SEND_STICKERS', label: 'Send stickers' },
      { name: 'SEND_GIFS', label: 'Send GIFs' },
      { name: 'SEND_POLLS', label: 'Create polls' },
      { name: 'ADD_REACTIONS', label: 'Add reactions' },
      { name: 'EMBED_LINKS', label: 'Embed links' },
      { name: 'MENTION_ALL', label: 'Mention everyone' },
      { name: 'EDIT_OWN_MESSAGES', label: 'Edit own messages' },
      { name: 'DELETE_OWN_MESSAGES', label: 'Delete own messages' },
      { name: 'DELETE_ANY_MESSAGE', label: 'Delete any message' },
      { name: 'PIN_MESSAGES', label: 'Pin messages' },
    ],
  },
  {
    label: 'Members',
    perms: [
      { name: 'KICK_MEMBERS', label: 'Kick members' },
      { name: 'BAN_MEMBERS', label: 'Ban members' },
      { name: 'MUTE_MEMBERS', label: 'Mute members' },
    ],
  },
  {
    label: 'Calls',
    perms: [
      { name: 'START_CALL', label: 'Start calls' },
      { name: 'JOIN_CALL', label: 'Join calls' },
      { name: 'END_CALL_FOR_ALL', label: 'End calls for everyone' },
      { name: 'SCREEN_SHARE', label: 'Share their screen' },
    ],
  },
];

// ─── Media uploads (non-attachment purposes) ─────────────────────────────────

export interface UploadedMediaDto {
  id: string;
  url: string;
  thumbnailUrl: string | null;
  mimeType: string;
  status: string;
}

interface CreateUploadRes {
  media: UploadedMediaDto;
  upload: { url: string; method: string; headers: Record<string, string> } | null;
  deduplicated: boolean;
}

/**
 * The same three-step pipeline as useAttachmentUpload, without the tray
 * machinery: create (with the right purpose, which picks the public bucket a
 * group avatar or emoji is served from) → PUT the bytes → confirm.
 */
export async function uploadMedia(
  file: File,
  purpose: 'conversation_avatar' | 'emoji',
): Promise<UploadedMediaDto> {
  const created = await api<CreateUploadRes>('/media/uploads', {
    method: 'POST',
    body: {
      filename: file.name || 'file',
      mimeType: file.type || 'application/octet-stream',
      size: file.size,
      purpose,
    },
  });

  if (!created.upload) return created.media; // deduplicated — already ready

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(created.upload.headers)) {
    if (name.toLowerCase() !== 'content-length') headers[name] = value;
  }
  const put = await fetch(created.upload.url, { method: 'PUT', headers, body: file });
  if (!put.ok) throw new Error(`Upload failed (${put.status})`);

  const confirmed = await api<{ media: UploadedMediaDto }>(`/media/${created.media.id}/confirm`, {
    method: 'POST',
  });
  return confirmed.media;
}

// ─── Campfire countdown ──────────────────────────────────────────────────────

/** "3h 12m" / "2d 4h" / "45m" / "any moment now". Null when unparseable. */
export function fmtRemaining(endsAt: string): string | null {
  const ms = Date.parse(endsAt) - Date.now();
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return 'any moment now';
  const mins = Math.floor(ms / 60_000);
  const d = Math.floor(mins / 1_440);
  const h = Math.floor((mins % 1_440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${Math.max(1, m)}m`;
}

/** Re-render once a minute — a countdown that never visibly drifts. */
export function useMinuteTick(enabled: boolean): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(timer);
  }, [enabled]);
  return tick;
}

/** The one error-to-string rule every panel shares. */
export const errText = (err: unknown, fallback: string): string =>
  err instanceof Error ? err.message : fallback;
