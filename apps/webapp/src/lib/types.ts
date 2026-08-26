/**
 * Client-side views of the wire shapes.
 *
 * Typed by hand against `apps/api/src/lib/serialize.ts` rather than imported:
 * the serializers return anonymous objects, and the server is free to add
 * fields without breaking us — everything here is the subset this client
 * actually renders. Optional/nullable follows the serializer, not hope.
 */

export interface PublicUser {
  id: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  isBot: boolean;
  isVerified: boolean;
  badge: string | null;
}

export interface Self extends PublicUser {
  email: string | null;
  bio: string | null;
  pronouns: string | null;
}

export interface Attachment {
  id: string;
  url: string;
  thumbnailUrl: string | null;
  mimeType: string;
  width: number | null;
  height: number | null;
  filename: string | null;
  caption?: string | null;
  isSpoiler?: boolean;
}

export interface EmbedView {
  type?: string;
  title?: string | null;
  description?: string | null;
  url?: string | null;
  color?: string | null;
  fields?: Array<{ name: string; value: string; inline: boolean }>;
  footer?: { text: string } | null;
  imageUrl?: string | null;
  thumbnailUrl?: string | null;
}

export interface Message {
  id: string;
  conversationId: string;
  seq: number;
  type: string;
  content: string | null;
  sender: PublicUser | null;
  senderId: string;
  senderRoleColor?: string | null;
  replyTo?: { id: string; content: string | null; sender?: PublicUser | null } | null;
  attachments: Attachment[];
  embeds?: EmbedView[] | null;
  gif?: { url: string; width?: number; height?: number } | null;
  createdAt: string;
  editedAt?: string | null;
  deletedAt?: string | null;
  reactions?: Array<{ emoji: string; count: number; me: boolean }>;
  /** Local-only: a send in flight, not yet confirmed by the server. */
  pending?: boolean;
  failed?: boolean;
}

export interface ConversationSelf {
  lastReadSeq: number;
  unreadCount: number;
  mentionCount: number;
  notificationLevel: string;
  mutedUntil: string | null;
  isPinned: boolean;
  isArchived: boolean;
}

export interface Conversation {
  id: string;
  type: 'dm' | 'group' | 'channel' | string;
  title: string | null;
  avatarUrl: string | null;
  memberCount: number;
  otherUser: PublicUser | null;
  latestSeq: number;
  lastMessageAt: string | null;
  lastMessage?: { content: string | null; sender?: PublicUser | null } | null;
  lastMessagePreview?: string | null;
  self?: ConversationSelf | null;
  pet?: { name: string | null; stage: string; mood: string } | null;
  endsAt?: string | null;
}

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  deviceId?: string;
  user?: Self;
  needsOnboarding?: boolean;
}
