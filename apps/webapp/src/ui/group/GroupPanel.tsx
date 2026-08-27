import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { Conversation, ConversationSelf, PublicUser } from '../../lib/types';
import { mutate, selectConversation, useStore } from '../../state/store';
import { Avatar } from '../Avatar';
import { Icon } from '../icons';
import { InvitePanel } from './InvitePanel';
import { PetCard } from './PetCard';
import './group.css';

/**
 * The right-hand details drawer for the open conversation: identity, the pet
 * (groups only), who is here, the member roster and the per-user actions.
 *
 * Wire shapes used (apps/api/src/routes/conversations.ts):
 *   GET    /v1/conversations/:id/members         → { members: [{ user, role, roleColor, nickname, ... }], nextCursor }
 *   PATCH  /v1/conversations/:id                 { title } → { conversation } (MANAGE_CONVERSATION)
 *   PATCH  /v1/conversations/:id/state           { mutedUntil?, isPinned?, isArchived?, ... } → { ok } (per-user, never broadcast)
 *   DELETE /v1/conversations/:id/members/:userId — with your own id this is "leave"
 *   DELETE /v1/conversations/:id                 — owner: deletes the group; non-owner: also just leaves
 */

interface MemberView {
  user: PublicUser;
  role: string;
  roleColor?: string | null;
  nickname?: string | null;
  isAffiliate?: boolean;
  joinedAt?: string;
}

/** "Muted forever" is a far-future timestamp; unmute is null. */
const MUTE_FOREVER = '2100-01-01T00:00:00.000Z';

const EMPTY_SELF: ConversationSelf = {
  lastReadSeq: 0,
  unreadCount: 0,
  mentionCount: 0,
  notificationLevel: 'all',
  mutedUntil: null,
  isPinned: false,
  isArchived: false,
};

export function GroupPanel(props: { conversation: Conversation; onClose: () => void }) {
  const { conversation, onClose } = props;
  const { state } = useStore();

  const [members, setMembers] = useState<MemberView[]>([]);
  const [membersLoading, setMembersLoading] = useState(true);
  const [showInvites, setShowInvites] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState(false);

  const me = state.me;
  const isDm = conversation.type === 'dm';
  const isGroup = conversation.type === 'group' && !conversation.parentId;

  useEffect(() => {
    let cancelled = false;
    setMembersLoading(true);
    setMembers([]);
    void (async () => {
      try {
        const res = await api<{ members: MemberView[] }>(
          `/conversations/${conversation.id}/members?limit=100`,
        );
        if (!cancelled) setMembers(res.members);
      } catch {
        /* the roster is decoration on a DM and recoverable elsewhere */
      } finally {
        if (!cancelled) setMembersLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversation.id]);

  const myRole = members.find((m) => m.user.id === me?.id)?.role ?? null;
  const canManage =
    myRole === 'owner' || myRole === 'admin' || conversation.ownerId === me?.id;

  const self = conversation.self;
  const muted = Boolean(self?.mutedUntil && Date.parse(self.mutedUntil) > Date.now());
  const pinned = self?.isPinned ?? false;
  const archived = self?.isArchived ?? false;
  const hereCount = state.viewers.get(conversation.id)?.size ?? 0;

  const title = isDm
    ? conversation.otherUser?.displayName ?? conversation.otherUser?.username ?? 'Direct message'
    : conversation.title ?? 'Untitled group';

  const fail = (err: unknown, fallback: string): void =>
    setError(err instanceof Error ? err.message : fallback);

  /** Per-user state: PATCH, then mirror locally (the echo event only reaches other devices). */
  const patchState = async (
    body: Record<string, unknown>,
    apply: (s: ConversationSelf) => void,
  ): Promise<void> => {
    setError(null);
    try {
      await api<{ ok: boolean }>(`/conversations/${conversation.id}/state`, {
        method: 'PATCH',
        body,
      });
      mutate((st) => {
        const conv = st.conversations.get(conversation.id);
        if (!conv) return;
        if (!conv.self) conv.self = { ...EMPTY_SELF };
        apply(conv.self);
      });
    } catch (err) {
      fail(err, 'Could not update');
    }
  };

  const saveTitle = async (): Promise<void> => {
    const next = titleDraft.trim();
    if (!next || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ conversation: Conversation }>(`/conversations/${conversation.id}`, {
        method: 'PATCH',
        body: { title: next },
      });
      mutate((st) => {
        const conv = st.conversations.get(conversation.id);
        if (conv) Object.assign(conv, res.conversation);
      });
      setRenaming(false);
    } catch (err) {
      fail(err, 'Could not rename');
    } finally {
      setBusy(false);
    }
  };

  const copyId = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(conversation.id);
      setCopiedId(true);
      setTimeout(() => setCopiedId(false), 1500);
    } catch {
      /* clipboard denied */
    }
  };

  const leave = async (): Promise<void> => {
    if (!me || busy) return;
    const isOwner = myRole === 'owner';
    const ok = window.confirm(
      isOwner
        ? 'You are the owner — leaving deletes this group for everyone. Continue?'
        : `Leave ${title}?`,
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      // A non-owner leaves through the member row; DELETE /:id as owner
      // deletes the whole group (the server treats non-owner DELETE /:id as a
      // leave too, but the member route says what it means).
      if (isOwner) {
        await api<{ deleted: boolean }>(`/conversations/${conversation.id}`, { method: 'DELETE' });
      } else {
        await api(`/conversations/${conversation.id}/members/${me.id}`, { method: 'DELETE' });
      }
      mutate((st) => {
        st.conversations.delete(conversation.id);
        st.messages.delete(conversation.id);
      });
      await selectConversation(null);
      onClose();
    } catch (err) {
      fail(err, 'Could not leave');
      setBusy(false);
    }
  };

  return (
    <aside className="gp-drawer">
      <div className="gp-head">
        <div className="gp-head-spacer" />
        <button className="grp-close" onClick={onClose} aria-label="Close details">
          <Icon name="close" size={18} />
        </button>
      </div>

      <div className="gp-identity">
        <Avatar
          kind={isDm ? 'person' : 'place'}
          name={title}
          url={isDm ? conversation.otherUser?.avatarUrl : conversation.avatarUrl}
          size={72}
        />
        {renaming ? (
          <div className="gp-inline-edit">
            <input
              autoFocus
              value={titleDraft}
              maxLength={100}
              onChange={(e) => setTitleDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void saveTitle();
                if (e.key === 'Escape') setRenaming(false);
              }}
            />
            <button
              className="gp-inline-save"
              disabled={busy || !titleDraft.trim()}
              onClick={() => void saveTitle()}
            >
              Save
            </button>
          </div>
        ) : (
          <div className="gp-title">
            <span>{title}</span>
            {!isDm && canManage && (
              <button
                className="gp-rename"
                title="Rename"
                onClick={() => {
                  setTitleDraft(conversation.title ?? '');
                  setRenaming(true);
                }}
              >
                <Icon name="edit" size={14} />
              </button>
            )}
          </div>
        )}
        {conversation.description && <div className="gp-desc">{conversation.description}</div>}
        <div className="gp-counts">
          <span>
            {conversation.memberCount} member{conversation.memberCount === 1 ? '' : 's'}
          </span>
          {hereCount > 0 && (
            <span className="gp-here">
              <Icon name="users" size={12} /> {hereCount} here now
            </span>
          )}
        </div>
      </div>

      {error && <div className="grp-error">{error}</div>}

      {isGroup && <PetCard conversation={conversation} canName={canManage} />}

      <div className="gp-section">
        <div className="gp-section-title">Actions</div>
        <div className="gp-actions">
          {!isDm && (
            <button className="gp-action" onClick={() => setShowInvites(true)}>
              <Icon name="link" size={16} /> Invite people
            </button>
          )}
          <button
            className="gp-action"
            onClick={() =>
              void patchState({ mutedUntil: muted ? null : MUTE_FOREVER }, (s) => {
                s.mutedUntil = muted ? null : MUTE_FOREVER;
              })
            }
          >
            <Icon name="bell" size={16} /> {muted ? 'Unmute' : 'Mute'}
            {muted && <span className="gp-action-state">muted</span>}
          </button>
          <button
            className="gp-action"
            onClick={() =>
              void patchState({ isPinned: !pinned }, (s) => {
                s.isPinned = !pinned;
              })
            }
          >
            <Icon name="pin" size={16} /> {pinned ? 'Unpin' : 'Pin'}
            {pinned && <span className="gp-action-state">pinned</span>}
          </button>
          <button
            className="gp-action"
            onClick={() =>
              void patchState({ isArchived: !archived }, (s) => {
                s.isArchived = !archived;
              })
            }
          >
            <Icon name="download" size={16} /> {archived ? 'Unarchive' : 'Archive'}
            {archived && <span className="gp-action-state">archived</span>}
          </button>
          <button className="gp-action" onClick={() => void copyId()}>
            <Icon name="copy" size={16} /> Copy group id
            {copiedId && <span className="gp-action-state">copied</span>}
          </button>
          {!isDm && (
            <button className="gp-action danger" disabled={busy} onClick={() => void leave()}>
              <Icon name="logout" size={16} />
              {myRole === 'owner' ? 'Delete group' : 'Leave group'}
            </button>
          )}
        </div>
      </div>

      <div className="gp-section">
        <div className="gp-section-title">
          Members{members.length > 0 ? ` — ${members.length}` : ''}
        </div>
        <div className="gp-members">
          {membersLoading && <div className="grp-hint">Loading members…</div>}
          {members.map((m) => {
            const name = m.nickname ?? m.user.displayName ?? m.user.username ?? 'Someone';
            const online = state.online.has(m.user.id);
            return (
              <div key={m.user.id} className="gp-member">
                <div className="gp-member-avatar">
                  <Avatar kind="person" name={name} url={m.user.avatarUrl} size={32} />
                  {online && <span className="gp-online-dot" />}
                </div>
                <div className="gp-member-main">
                  <div
                    className="gp-member-name"
                    style={m.roleColor ? { color: m.roleColor } : undefined}
                  >
                    <span
                      style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >
                      {name}
                    </span>
                    {m.role === 'owner' && (
                      <span className="gp-crown" title="Owner" style={{ color: 'var(--yellow)' }}>
                        <Icon name="crown" size={13} />
                      </span>
                    )}
                  </div>
                  {m.user.username && <div className="gp-member-sub">@{m.user.username}</div>}
                </div>
                {m.role !== 'member' && m.role !== 'owner' && (
                  <span className="gp-role">{m.role}</span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {showInvites && (
        <InvitePanel conversation={conversation} onClose={() => setShowInvites(false)} />
      )}
    </aside>
  );
}
