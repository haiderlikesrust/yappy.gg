/**
 * Desktop notifications and the tab badge.
 *
 * The permission is only ever requested from an explicit user action (the
 * settings toggle) — browsers punish ambush prompts and so do people. Whether
 * to *show* one is decided per message: never for the conversation on screen
 * in a focused tab, never when the sender is you.
 */

import { isLocked } from './applock';

export function notificationsEnabled(): boolean {
  return typeof Notification !== 'undefined' && Notification.permission === 'granted';
}

export async function requestNotificationPermission(): Promise<boolean> {
  if (typeof Notification === 'undefined') return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  return (await Notification.requestPermission()) === 'granted';
}

export function showMessageNotification(input: {
  title: string;
  body: string;
  conversationId: string;
  icon?: string | null;
  onClick?: () => void;
}): void {
  if (!notificationsEnabled()) return;

  // A locked window must not read the message out on the desktop. The whole
  // point of covering the screen is undone by a toast that quotes it.
  const covered = isLocked();
  try {
    const n = new Notification(covered ? 'yappy' : input.title, {
      body: covered ? 'New message' : input.body,
      icon: covered ? undefined : (input.icon ?? undefined),
      tag: `yappy-${input.conversationId}`,
    });
    n.onclick = () => {
      window.focus();
      input.onClick?.();
      n.close();
    };
  } catch {
    /* some browsers throw off the main window context — a lost toast, not a bug */
  }
}

/** "(3) yappy" in the tab — the cheapest unread surface there is. */
export function setTitleBadge(unread: number): void {
  document.title = unread > 0 ? `(${unread > 99 ? '99+' : unread}) yappy` : 'yappy';
}
