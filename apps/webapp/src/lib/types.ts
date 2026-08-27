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

export interface EmbedInvite {
  code: string;
  type?: string | null;
  title?: string | null;
  description?: string | null;
  badge?: string | null;
  memberCount?: number;
  avatarUrl?: string | null;
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
  /** yapper's drawn charts (see ChartEmbed). */
  chart?: ChartEmbed | null;
  /** A group invite pasted as a link, unfurled into a joinable card. */
  invite?: EmbedInvite | null;
}

export interface PollView {
  question: string;
  options: Array<{ id: string; text: string; votes: number; me?: boolean }>;
  multiSelect: boolean;
  anonymous?: boolean;
  totalVotes?: number;
  closesAt?: string | null;
  closedAt?: string | null;
  myVotes?: string[];
}

export interface ChartEmbed {
  kind: 'line' | 'area' | 'bar' | 'pie' | 'donut' | 'scatter';
  points: Array<{ label: string; value: number }>;
}

export interface StickerView {
  id: string;
  url: string;
  emoji?: string | null;
  name?: string | null;
}

export interface MessageButton {
  type: 'button';
  customId: string;
  label: string;
  style?: string;
  disabled?: boolean;
  url?: string;
  onlyUserId?: string;
}

export interface Message {
  id: string;
  conversationId: string;
  seq: number;
  type: string;
  content: string | null;
  entities?: Array<{ type: string; offset?: number; length?: number; userId?: string }> | null;
  sender: PublicUser | null;
  senderId: string;
  senderRoleColor?: string | null;
  replyTo?: { id: string; content: string | null; sender?: PublicUser | null } | null;
  threadRootId?: string | null;
  threadReplyCount?: number;
  forwardedFrom?: { userId?: string } | null;
  attachments: Attachment[];
  embeds?: EmbedView[] | null;
  gif?: { url: string; width?: number; height?: number } | null;
  sticker?: StickerView | null;
  poll?: PollView | null;
  components?: Array<{ type: 'row'; components: MessageButton[] }> | null;
  location?: { lat: number; lng: number; label?: string | null } | null;
  isPinned?: boolean;
  createdAt: string;
  editedAt?: string | null;
  deletedAt?: string | null;
  /** The wire shape: counts keyed by emoji, plus which of them are mine. */
  reactions?: Record<string, number>;
  myReactions?: string[];
  /** Local-only: a send in flight, not yet confirmed by the server. */
  pending?: boolean;
  failed?: boolean;
}

/** The render shape the chips want, derived from the wire fields. */
export function reactionChips(
  msg: Pick<Message, 'reactions' | 'myReactions'>,
): Array<{ emoji: string; count: number; me: boolean }> {
  const mine = new Set(msg.myReactions ?? []);
  return Object.entries(msg.reactions ?? {})
    .filter(([, count]) => count > 0)
    .map(([emoji, count]) => ({ emoji, count, me: mine.has(emoji) }));
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

export interface GroupPet {
  name: string | null;
  species?: string;
  stage: string;
  mood: string;
  streak?: number;
  fedToday?: boolean;
}

export interface Conversation {
  id: string;
  type: 'dm' | 'group' | 'channel' | string;
  parentId?: string | null;
  title: string | null;
  description?: string | null;
  avatarUrl: string | null;
  handle?: string | null;
  isPublic?: boolean;
  badge?: string | null;
  ownerId?: string | null;
  memberCount: number;
  hereCount?: number;
  otherUser: PublicUser | null;
  latestSeq: number;
  lastMessageAt: string | null;
  /** Realtime updates set content+sender; the REST list sends a summary with
   *  `preview` and `senderId` instead. The sidebar reads both. */
  lastMessage?: {
    content?: string | null;
    preview?: string | null;
    sender?: PublicUser | null;
    senderId?: string;
  } | null;
  lastMessagePreview?: string | null;
  self?: ConversationSelf | null;
  pet?: GroupPet | null;
  endsAt?: string | null;
  slowModeSeconds?: number;
  disappearingSeconds?: number;
}

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  deviceId?: string;
  user?: Self;
  needsOnboarding?: boolean;
}
