/**
 * Space plumbing: the wire shapes and store writes behind the sidebar cards.
 *
 * The server's model (apps/api/src/routes/spaces.ts): a conversation with
 * `type === 'space'` is a container that holds membership; its channels are
 * ordinary conversations with `type === 'channel'` and `parentId` set to the
 * space. The home list excludes anything with a parentId, so channels only
 * ever render inside their space's card.
 */

import { Permission } from '@yappy/shared';
import { api } from '../../lib/api';
import type { Conversation, ConversationSelf } from '../../lib/types';
import { gateway, getState, mutate, type VoiceParticipant } from '../../state/store';

/**
 * Wire fields this feature reads that the shared client type does not carry.
 * `types.ts` is deliberately the subset the whole app renders; these ride on
 * the same objects (the serializer sends them) and only spaces care.
 */
export interface SpaceConversation extends Conversation {
  /** Sort order among a space's channels. */
  position?: number;
  /** The divider it is filed under, or null for loose. */
  categoryId?: string | null;
  /** The viewer's effective permission bitfield, as a decimal string. */
  permissions?: string | null;
  self?: (ConversationSelf & { role?: string }) | null;
  /** Closed to the space until a role overwrite lets somebody back in. */
  isPrivate?: boolean;
  /** Read-only-for-members channel (lowered permission floor). */
  isAnnouncement?: boolean;
  /** A list of titled posts rather than a timeline. */
  isForum?: boolean;
  /** A drop-in voice room — clicking joins, there is no timeline to open. */
  isVoice?: boolean;
  /**
   * Set by ConversationUpdate broadcasts when the channel set changed
   * (create/reorder/delete/upgrade). The store merges the event payload into
   * the space's object; ChannelList watches for it, refetches, and clears it.
   */
  channelsChanged?: boolean;
}

/** A named divider in a space's channel list. Ordered, and nothing else. */
export interface ChannelCategory {
  id: string;
  name: string;
  position: number;
}

/**
 * Categories, per space, kept beside the conversations rather than inside
 * them. They are not conversations — no members, no messages, nothing to
 * select — and giving them a Conversation-shaped home would mean every list
 * in the app had to learn to skip them.
 *
 * Outside the store and so not itself reactive, which is safe only because
 * this is written in the same breath as the channels: every path that changes
 * a category ends in `loadChannels`, and `foldChannels` writes every channel
 * into the store, which is what re-renders the list. Anything that ever sets
 * this without that mutate would silently not paint.
 */
const categoriesBySpace = new Map<string, ChannelCategory[]>();

export const categoriesOf = (spaceId: string): ChannelCategory[] =>
  categoriesBySpace.get(spaceId) ?? [];

export const isSpace = (c: Conversation): boolean => c.type === 'space';

/**
 * Who may create/reorder/delete channels: MANAGE_CONVERSATION (admins have
 * it, see @yappy/shared permissions). The full view sends the resolved
 * bitfield; the home list does not, so fall back to the role the member row
 * carries.
 */
export function canManageSpace(space: Conversation): boolean {
  const s = space as SpaceConversation;
  if (s.permissions) {
    try {
      const bits = BigInt(s.permissions);
      return (bits & (Permission.MANAGE_CONVERSATION | Permission.ADMINISTRATOR)) !== 0n;
    } catch {
      /* not a decimal string — trust the role instead */
    }
  }
  const role = s.self?.role;
  return role === 'owner' || role === 'admin';
}

/** GET /conversations/:id/channels — the slim per-viewer channel entry. */
interface ChannelEntry {
  id: string;
  title: string | null;
  description: string | null;
  position: number;
  /** The divider it is filed under; null means loose, above them all. */
  categoryId: string | null;
  latestSeq: number;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  unreadCount: number;
  mentionCount: number;
  notificationLevel: string;
  isMuted: boolean;
  isAnnouncement: boolean;
  /** Reads as a page of cards rather than a conversation. */
  isBoard?: boolean;
  /** A list of titled posts rather than a conversation. */
  isForum?: boolean;
  /** Closed to the space until a role overwrite lets somebody back in. */
  isPrivate?: boolean;
  /** The viewer's own permission bits here, as a decimal string. */
  permissions?: string | null;
  /**
   * Whether this viewer may post here, as the server sees it.
   *
   * Sent rather than inferred: working it out from "is this announcements"
   * and "am I an admin" means reimplementing the permission stack in the
   * client, and getting it wrong the first time a role override exists.
   */
  canPost?: boolean;
  isVoice?: boolean;
  /** Present on voice channels: who is inside right now. */
  voiceParticipants?: VoiceParticipant[];
}

/**
 * The entry is muted but only ships a boolean; the store keeps a timestamp
 * (that is what the notification path checks). Far-future stands in until a
 * real one arrives from a richer payload.
 */
const FAR_FUTURE = '2099-01-01T00:00:00.000Z';

/**
 * Fetch a space's channels and fold them into the store as Conversations, so
 * `selectConversation` (and everything downstream — history, receipts, the
 * composer) works on a channel like on any other room.
 */
function foldChannels(
  conversations: Map<string, Conversation>,
  voice: Map<string, VoiceParticipant[]>,
  spaceId: string,
  channels: ChannelEntry[],
): void {
  for (const ch of channels) {
    const existing = conversations.get(ch.id) as SpaceConversation | undefined;
    const next: SpaceConversation = {
      ...existing,
      id: ch.id,
      type: 'channel',
      parentId: spaceId,
      position: ch.position,
      categoryId: ch.categoryId ?? null,
      title: ch.title,
      description: ch.description,
      avatarUrl: existing?.avatarUrl ?? null,
      memberCount: existing?.memberCount ?? 0,
      otherUser: null,
      latestSeq: ch.latestSeq,
      lastMessageAt: ch.lastMessageAt,
      lastMessagePreview: ch.lastMessagePreview,
      isAnnouncement: ch.isAnnouncement,
      isBoard: ch.isBoard ?? false,
      isForum: ch.isForum ?? false,
      isPrivate: ch.isPrivate ?? false,
      canPost: ch.canPost ?? true,
      permissions: ch.permissions ?? null,
      isVoice: ch.isVoice ?? false,
      self: {
        isPinned: existing?.self?.isPinned ?? false,
        isArchived: existing?.self?.isArchived ?? false,
        isHidden: existing?.self?.isHidden ?? false,
        lastReadSeq: Math.max(0, ch.latestSeq - ch.unreadCount),
        unreadCount: ch.unreadCount,
        mentionCount: ch.mentionCount,
        notificationLevel: ch.notificationLevel,
        mutedUntil: ch.isMuted ? (existing?.self?.mutedUntil ?? FAR_FUTURE) : null,
      },
    };
    conversations.set(ch.id, next);
    // Seed the roster; live voice.state snapshots replace it from here on.
    if (ch.isVoice) voice.set(ch.id, ch.voiceParticipants ?? []);
  }
}

export async function loadChannels(spaceId: string): Promise<void> {
  const res = await api<{ channels: ChannelEntry[]; categories?: ChannelCategory[] }>(
    `/conversations/${spaceId}/channels`,
  );
  categoriesBySpace.set(spaceId, res.categories ?? []);
  mutate((s) => foldChannels(s.conversations, s.voice, spaceId, res.channels), 'conversations', 'voice');
  // Messages only stream on subscribed topics, and IDENTIFY may predate these
  // channels for this session. Cheap and membership-checked server-side.
  for (const ch of res.channels) gateway.subscribe(ch.id);
}

/** One paint for every space's rooms, instead of a refetch-and-rerender each. */
export async function loadChannelsForSpaces(spaceIds: string[]): Promise<void> {
  if (spaceIds.length === 0) return;
  const results = await Promise.all(
    spaceIds.map(async (id) => {
      try {
        const res = await api<{ channels: ChannelEntry[]; categories?: ChannelCategory[] }>(
          `/conversations/${id}/channels`,
        );
        categoriesBySpace.set(id, res.categories ?? []);
        return { id, channels: res.channels };
      } catch {
        return { id, channels: null as ChannelEntry[] | null };
      }
    }),
  );
  mutate((s) => {
    for (const { id, channels } of results) {
      if (channels) foldChannels(s.conversations, s.voice, id, channels);
    }
  }, 'conversations', 'voice');
  for (const { channels } of results) {
    if (channels) for (const ch of channels) gateway.subscribe(ch.id);
  }
}

/** A space's channels, in server order: position, then title. */
export function channelsOf(
  conversations: Map<string, Conversation>,
  spaceId: string,
): SpaceConversation[] {
  const list: SpaceConversation[] = [];
  for (const c of conversations.values()) {
    if ((c as SpaceConversation).parentId === spaceId) list.push(c as SpaceConversation);
  }
  return list.sort(
    (a, b) =>
      (a.position ?? 0) - (b.position ?? 0) || (a.title ?? '').localeCompare(b.title ?? ''),
  );
}

/** POST a new divider. The list refetches, which is what paints it. */
export async function createCategory(spaceId: string, name: string): Promise<void> {
  await api(`/conversations/${spaceId}/categories`, { method: 'POST', body: { name } });
  await loadChannels(spaceId);
}

export async function renameCategory(
  spaceId: string,
  categoryId: string,
  name: string,
): Promise<void> {
  await api(`/conversations/${spaceId}/categories/${categoryId}`, {
    method: 'PATCH',
    body: { name },
  });
  await loadChannels(spaceId);
}

/** The channels inside survive this — the server sets them loose. */
export async function deleteCategory(spaceId: string, categoryId: string): Promise<void> {
  await api(`/conversations/${spaceId}/categories/${categoryId}`, { method: 'DELETE' });
  await loadChannels(spaceId);
}

/**
 * Move a channel between categories.
 *
 * Sent as a reorder because that is what it is: the server takes the whole
 * order and the moves together, so the channel is never briefly filed in one
 * place and sorted for another.
 */
export async function moveChannelToCategory(
  spaceId: string,
  channelId: string,
  categoryId: string | null,
): Promise<void> {
  const ordered = channelsOf(getState().conversations, spaceId);
  mutate((s) => {
    const c = s.conversations.get(channelId) as SpaceConversation | undefined;
    if (c) c.categoryId = categoryId;
  }, 'conversations');
  try {
    await api(`/conversations/${spaceId}/channels/order`, {
      method: 'PUT',
      body: {
        channelIds: ordered.map((c) => c.id),
        categories: { [channelId]: categoryId },
      },
    });
  } catch {
    await loadChannels(spaceId);
  }
}

/**
 * PUT the complete order (the route insists on every channel exactly once).
 * Optimistic — positions are rewritten locally first so the list does not
 * jump back while the round trip completes; a failure refetches server truth.
 */
export async function reorderChannels(spaceId: string, orderedIds: string[]): Promise<void> {
  mutate((s) => {
    orderedIds.forEach((id, index) => {
      const c = s.conversations.get(id) as SpaceConversation | undefined;
      if (c) c.position = index;
    });
  }, 'conversations');
  try {
    await api(`/conversations/${spaceId}/channels/order`, {
      method: 'PUT',
      body: { channelIds: orderedIds },
    });
  } catch {
    await loadChannels(spaceId);
  }
}
