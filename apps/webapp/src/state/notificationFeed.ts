import { api, auth } from "../lib/api";
import { sessionResource } from "../lib/sessionResource";
import type {
  MentionEntry,
  NotificationEntry,
} from "../ui/chat/notificationModel";

export interface NoticePage {
  notifications: NotificationEntry[];
  nextCursor: string | null;
  supportsSelectiveRead?: boolean;
}
const account = () => (auth.isSignedIn ? (auth.user?.id ?? null) : null);
export const noticeFeed = sessionResource(account, () =>
  api<NoticePage>("/social/notifications?limit=40"),
);
export const mentionFeed = sessionResource(account, () =>
  api<{ mentions: MentionEntry[] }>("/users/me/mentions?limit=40&preview=1"),
);

export function warmNotificationFeed() {
  void noticeFeed.load().catch(() => {});
  void mentionFeed.load().catch(() => {});
}

export function rememberNotificationsRead(ids: Set<string>) {
  const now = new Date().toISOString();
  noticeFeed.update((page) => ({
    ...page,
    notifications: page.notifications.map((entry) =>
      ids.has(entry.id) ? { ...entry, readAt: entry.readAt ?? now } : entry,
    ),
  }));
}
