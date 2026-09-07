import { api } from "../../lib/api";
import { mutate, selectConversation, syncUrl } from "../../state/store";
import { jumpToMessage } from "../chat/jump";

export const community = <T>(path: string, method = "GET", body?: unknown) =>
  api<T>("/community" + path, { method, body });
export type Activity = {
  id: string;
  kind: string;
  conversationId: string;
  conversationTitle: string | null;
  messageId?: string;
  seq?: number;
  title: string;
  body: string;
  createdAt: string;
};
export type CatchUp = {
  items: Activity[];
  rooms: { conversationId: string; title: string; unreadCount: number }[];
};
export type CommunityEvent = {
  id: string;
  conversationId: string;
  creatorId: string;
  conversationTitle: string;
  title: string;
  description: string;
  location: string;
  startsAt: string;
  endsAt: string | null;
  cancelledAt: string | null;
  response: string | null;
  remind: boolean;
  going: number;
  maybe: number;
  canManage?: boolean;
};
export type Collection = { id: string; name: string; count?: number };
export type Saved = {
  messageId: string;
  conversationId: string;
  conversationTitle: string | null;
  seq: number;
  content: string;
  sender: string;
  savedAt: string;
  collectionId: string | null;
  note: string;
};
export type Reminder = {
  id: string;
  conversationId: string;
  messageId: string | null;
  seq: number | null;
  eventId: string | null;
  dueAt: string;
  title: string;
  conversationTitle: string | null;
};
export type Scheduled = {
  id: string;
  conversationId: string;
  conversationTitle: string | null;
  content: string;
  sendAt: string;
  failedAt: string | null;
  failure: string | null;
};
export type Welcome = {
  tags?: string[];
  language?: string;
  welcome?: string;
  rules?: string;
  startChannelId?: string | null;
};
export type WelcomePage = {
  profile: Welcome;
  seen: boolean;
  canManage: boolean;
  channels?: { id: string; title: string | null }[];
};
export const localInput = (date: Date) =>
  new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
export const when = (date: string) =>
  new Date(date).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
export const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Couldn’t complete that. Please try again.";
export async function openMessage(conversationId: string, seq?: number | null) {
  mutate((s) => {
    s.view = "chats";
  }, "ui");
  await selectConversation(conversationId);
  syncUrl();
  if (seq != null) await jumpToMessage(conversationId, seq);
}
