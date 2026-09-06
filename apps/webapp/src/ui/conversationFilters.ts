import type { Conversation } from '../lib/types';

export const CHAT_FILTERS = ['All', 'Places', 'People', 'Unread'] as const;
export type ChatFilter = (typeof CHAT_FILTERS)[number];
export function conversationUnread(
  conversation: Conversation,
  children: readonly Conversation[] = [],
): number {
  return Math.max(
    conversation.self?.unreadCount ?? 0,
    children.reduce(
      (n, c) => n + (c.self?.isHidden || c.self?.isArchived ? 0 : (c.self?.unreadCount ?? 0)),
      0,
    ),
  );
}
export function filterConversations(
  conversations: readonly Conversation[],
  filter: ChatFilter,
  query: string,
): Conversation[] {
  const children = new Map<string, Conversation[]>();
  for (const c of conversations) {
    if (!c.parentId || c.self?.isHidden || c.self?.isArchived) continue;
    children.set(c.parentId, [...(children.get(c.parentId) ?? []), c]);
  }
  const term = query.trim().toLocaleLowerCase();
  return conversations.filter((c) => {
    if (c.parentId || c.self?.isHidden || c.self?.isArchived) return false;
    if (term)
      return [
        c.title,
        c.otherUser?.displayName,
        c.otherUser?.username,
        ...(children.get(c.id) ?? []).map((child) => child.title),
      ].some((value) => value?.toLocaleLowerCase().includes(term));
    return (
      filter === 'All' ||
      (filter === 'People' && c.type === 'dm') ||
      (filter === 'Places' && c.type !== 'dm') ||
      (filter === 'Unread' && conversationUnread(c, children.get(c.id)) > 0)
    );
  });
}
