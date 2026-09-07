import type { Message, PublicUser } from '../../lib/types';
import type { IconName } from '../icons';

export interface NotificationEntry {
  id: string;
  kind: string;
  actor: PublicUser | null;
  targetType: string | null;
  targetId: string | null;
  data: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}
export interface MentionEntry {
  isBroadcast: boolean;
  unread?: boolean;
  conversation: {
    id: string;
    type: string;
    title: string | null;
    parentId: string | null;
    parentTitle: string | null;
  };
  message: Pick<Message, 'id' | 'seq' | 'createdAt' | 'content' | 'sender'> | null;
}
export const noticeText = (entry: NotificationEntry, key: string): string | undefined =>
  typeof entry.data?.[key] === 'string' ? (entry.data[key] as string) : undefined;

const SYSTEM_KINDS = new Set([
  'account_suspended',
  'account_restored',
  'new_sign_in',
  'badge_granted',
  'badge_revoked',
  'group_removed',
  'group_banned',
  'group_unbanned',
  'report_reviewed',
  'bug_updated',
]);

export function noticeCopy(entry: NotificationEntry) {
  const group = noticeText(entry, 'title') || 'A group';
  const actor = entry.actor?.displayName || entry.actor?.username || 'Someone';
  const badge = noticeText(entry, 'badge') || 'verified';
  const system = SYSTEM_KINDS.has(entry.kind);
  const icons: Record<string, IconName> = {
    account_suspended: 'shield',
    account_restored: 'shield',
    new_sign_in: 'lock',
    badge_granted: 'shield',
    badge_revoked: 'shield',
    group_removed: 'users',
    group_banned: 'shield',
    group_unbanned: 'users',
    report_reviewed: 'shield',
    bug_updated: 'settings',
  };
  const copy = (title: string, body: string, place = true) => ({
    title,
    body,
    place,
    system,
    icon: icons[entry.kind] || 'bell',
    danger: entry.kind === 'account_suspended' || entry.kind === 'group_banned',
  });
  if (system)
    return copy(
      noticeText(entry, 'title') || 'Account update',
      noticeText(entry, 'body') || 'View the details of this update.',
      false,
    );
  if (['message_reminder', 'event_reminder', 'scheduled_failed', 'event_updated'].includes(entry.kind))
    return copy(noticeText(entry, 'title') || 'Reminder', noticeText(entry, 'body') || 'Open to view this update.');
  switch (entry.kind) {
    case 'group_verified':
      return copy(
        badge === 'partner' ? `${group} is a yappy partner` : `${group} is verified`,
        'The badge is on the group now. Admins can affiliate members from the group page.',
      );
    case 'group_verification_declined':
      return copy(
        `${group} is no longer ${badge}`,
        'Its affiliates lose the badge with it. You can ask again from group settings.',
      );
    case 'affiliate_granted':
      return copy(
        `${group} made you an affiliate`,
        'Its badge can sit beside your name. Turn it on in Settings.',
      );
    case 'affiliate_revoked':
      return copy(
        `${group} removed your affiliate status`,
        'Its badge no longer appears beside your name.',
      );
    case 'role_granted': {
      const role = noticeText(entry, 'role') || 'admin';
      const label = role === 'owner' ? 'the owner' : role === 'admin' ? 'an admin' : `a ${role}`;
      return copy(`You’re ${label} of ${group}`, `${actor} gave you the role.`);
    }
    case 'follow':
      return copy(`${actor} followed you`, 'View their profile.', false);
    case 'follow_back':
      return copy(`${actor} followed you back`, 'You follow each other now.', false);
    default:
      return {
        ...copy(
          noticeText(entry, 'title') || 'An update for you',
          noticeText(entry, 'body') || 'View notification details.',
          false,
        ),
        system: true,
      };
  }
}
export type InboxRow =
  { type: 'notice'; entry: NotificationEntry } | { type: 'mention'; entry: MentionEntry };
export const rowTime = (row: InboxRow) =>
  row.type === 'notice' ? row.entry.createdAt : row.entry.message?.createdAt || '';
export function inboxRows(notices: NotificationEntry[], mentions: MentionEntry[]): InboxRow[] {
  return [
    ...notices.map((entry) => ({ type: 'notice' as const, entry })),
    ...mentions.map((entry) => ({ type: 'mention' as const, entry })),
  ].sort((a, b) => (Date.parse(rowTime(b)) || 0) - (Date.parse(rowTime(a)) || 0));
}
export function mentionWhere(entry: MentionEntry) {
  const c = entry.conversation;
  const title = c.title || (c.type === 'dm' ? 'Direct message' : 'Untitled');
  return c.parentTitle ? `${c.parentTitle} / ${title}` : title;
}
export function inboxTime(iso: string) {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 60) return 'now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
