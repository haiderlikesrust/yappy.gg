import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { devModeEnabled } from '../../lib/devmode';
import type { Conversation, ConversationSelf, PublicUser } from '../../lib/types';
import { mutate, selectConversation, useStore } from '../../state/store';
import { Avatar } from '../Avatar';
import { BadgeMark, IdentityMarks } from '../badges';
import { Icon } from '../icons';
import { SpaceOverview, UpgradeToSpace } from '../space';
import { BansPanel } from './BansPanel';
import { EmojiManager } from './EmojiManager';
import { GroupSettingsPanel } from './GroupSettingsPanel';
import {
  Glyph,
  Permission,
  effectivePerms,
  errText,
  fmtRemaining,
  has,
  useMinuteTick,
} from './groupKit';
import { InvitePanel } from './InvitePanel';
import { MediaWall } from './MediaWall';
import { MemberRolesEditor, RolesPanel, type RoleInfo } from './RolesPanel';
import { PetCard } from './PetCard';
import { StickerStore } from './StickerStore';
import { TransferOwnership } from './TransferOwnership';
import { VerificationWizard } from './VerificationWizard';
import './group.css';

/**
 * The right-hand details drawer for the open conversation: identity, the pet
 * (groups only), who is here, the member roster and per-user actions — plus
 * the admin surfaces (settings, roles, bans, emoji, verification, transfer)
 * and the media wall, each a sub-panel launched from here.
 *
 * Wire shapes used directly (apps/api/src/routes/conversations.ts):
 *   GET    /v1/conversations/:id/members          → { members: [{ user, role, roles, roleColor, … }] }
 *   PATCH  /v1/conversations/:id                  { title } → { conversation } (MANAGE_CONVERSATION)
 *   PATCH  /v1/conversations/:id/state            per-user state, never broadcast
 *   DELETE /v1/conversations/:id[/members/:userId] leave / delete
 *   POST   /v1/conversations/:id/bans/:userId     { reason? } — ban from the member row
 * Permission gating reads the view's `permissions` bitfield (decimal string)
 * via effectivePerms, falling back to the ladder role while members load.
 */

interface MemberView {
  user: PublicUser;
  role: string;
  roles?: Array<{ id: string; name: string; color: string | null }>;
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
  isHidden: false,
};

type SubPanel =
  | 'invites'
  | 'settings'
  | 'spaceSettings'
  | 'spaceOverview'
  | 'roles'
  | 'bans'
  | 'transfer'
  | 'verify'
  | 'emoji'
  | 'stickers'
  | 'upgrade'
  | null;

type MemberTool = { userId: string; tool: 'roles' | 'ban' } | null;

export function GroupPanel(props: { conversation: Conversation; onClose: () => void }) {
  const { conversation, onClose } = props;
  const { state } = useStore();

  const [members, setMembers] = useState<MemberView[]>([]);
  const [membersLoading, setMembersLoading] = useState(true);
  const [panel, setPanel] = useState<SubPanel>(null);
  const [tab, setTab] = useState<'about' | 'media'>('about');
  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState(false);
  const [memberTool, setMemberTool] = useState<MemberTool>(null);
  const [banReason, setBanReason] = useState('');
  const [allRoles, setAllRoles] = useState<RoleInfo[] | null>(null);

  const me = state.me;
  const isDm = conversation.type === 'dm';
  const isGroup = conversation.type === 'group' && !conversation.parentId;
  const isCampfire = Boolean(conversation.endsAt);

  /**
   * Channels manage their SPACE. Membership, roles, bans, badges and
   * affiliation all live on the container — a channel has none of its own —
   * so every management surface in this drawer is scoped to the space when
   * one exists. Channel-level things (rename, mute, notifications, slow
   * mode) keep using the channel itself.
   */
  const isChannel = conversation.type === 'channel';
  const spaceScopedId = isChannel ? (conversation.parentId ?? conversation.id) : conversation.id;
  const parentSpace = isChannel
    ? (state.conversations.get(conversation.parentId ?? '') ?? null)
    : null;
  const scope = parentSpace ?? conversation;

  useEffect(() => {
    let cancelled = false;
    setMembersLoading(true);
    setMembers([]);
    setMemberTool(null);
    setAllRoles(null);
    setTab('about');
    void (async () => {
      try {
        const res = await api<{ members: MemberView[] }>(
          `/conversations/${spaceScopedId}/members?limit=100`,
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
  }, [spaceScopedId]);

  const myRole = members.find((m) => m.user.id === me?.id)?.role ?? null;
  const isOwner = myRole === 'owner' || conversation.ownerId === me?.id;
  const perms = effectivePerms(conversation, isOwner ? 'owner' : myRole);
  const canManage = has(perms, Permission.MANAGE_CONVERSATION);
  const canRoles = has(perms, Permission.MANAGE_ROLES);
  const canBan = has(perms, Permission.BAN_MEMBERS);
  const canStickers = has(perms, Permission.MANAGE_STICKERS);

  const self = conversation.self;
  const muted = Boolean(self?.mutedUntil && Date.parse(self.mutedUntil) > Date.now());
  const pinned = self?.isPinned ?? false;
  const archived = self?.isArchived ?? false;
  const hidden = self?.isHidden ?? false;
  const hereCount = state.viewers.get(conversation.id)?.size ?? 0;

  useMinuteTick(isCampfire);
  const remaining = conversation.endsAt ? fmtRemaining(conversation.endsAt) : null;

  const title = isDm
    ? conversation.otherUser?.displayName ?? conversation.otherUser?.username ?? 'Direct message'
    : conversation.title ?? 'Untitled group';

  const fail = (err: unknown, fallback: string): void => setError(errText(err, fallback));

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

  const copyId = async (id: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(id);
      setCopiedId(true);
      setTimeout(() => setCopiedId(false), 1500);
    } catch {
      /* clipboard denied */
    }
  };

  const leave = async (): Promise<void> => {
    if (!me || busy) return;
    const owner = myRole === 'owner';
    // From a channel this means the SPACE: membership lives on the container,
    // and "leave #general but stay in the space" is not a thing. The old code
    // deleted the channel's member row — or, as owner, the channel itself.
    const targetTitle = isChannel ? (scope.title ?? 'this space') : title;
    const ok = window.confirm(
      owner
        ? `You are the owner — leaving deletes ${isChannel ? 'the whole space and every channel in it' : 'this group'} for everyone. Continue?`
        : `Leave ${targetTitle}?`,
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      // A non-owner leaves through the member row; DELETE /:id as owner
      // deletes the whole thing (the server treats non-owner DELETE /:id as a
      // leave too, but the member route says what it means).
      if (owner) {
        await api<{ deleted: boolean }>(`/conversations/${spaceScopedId}`, { method: 'DELETE' });
      } else {
        await api(`/conversations/${spaceScopedId}/members/${me.id}`, { method: 'DELETE' });
      }
      mutate((st) => {
        st.conversations.delete(spaceScopedId);
        st.messages.delete(spaceScopedId);
        for (const [id, c] of [...st.conversations]) {
          if (c.parentId === spaceScopedId) {
            st.conversations.delete(id);
            st.messages.delete(id);
          }
        }
      });
      await selectConversation(null);
      onClose();
    } catch (err) {
      fail(err, 'Could not leave');
      setBusy(false);
    }
  };

  /** The roles list, fetched once and shared by every member-row editor. */
  const ensureRoles = async (): Promise<void> => {
    if (allRoles !== null) return;
    try {
      const res = await api<{ roles: RoleInfo[] }>(`/conversations/${spaceScopedId}/roles`);
      setAllRoles(res.roles);
    } catch (err) {
      fail(err, 'Could not load roles');
    }
  };

  const banMember = async (m: MemberView): Promise<void> => {
    setError(null);
    try {
      const reason = banReason.trim();
      await api<{ banned: boolean }>(`/conversations/${conversation.id}/bans/${m.user.id}`, {
        method: 'POST',
        body: reason ? { reason } : {},
      });
      setMembers((list) => list.filter((x) => x.user.id !== m.user.id));
      mutate((st) => {
        const conv = st.conversations.get(spaceScopedId);
        if (conv) conv.memberCount = Math.max(0, conv.memberCount - 1);
      });
      setMemberTool(null);
      setBanReason('');
    } catch (err) {
      fail(err, 'Could not ban that member');
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
            {!isDm && conversation.badge && <BadgeMark badge={conversation.badge} size={15} />}
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
        {isChannel && parentSpace && (
          <button className="gp-in-space" onClick={() => setPanel('spaceOverview')}>
            in {parentSpace.title ?? 'a space'}
            {parentSpace.badge && <BadgeMark badge={parentSpace.badge} size={12} />}
          </button>
        )}
        {remaining && (
          <div className="gp-campfire" title="This is a campfire — the whole place disappears">
            <Glyph name="flame" size={13} /> burns out in {remaining}
          </div>
        )}
        {conversation.description && <div className="gp-desc">{conversation.description}</div>}
        <div className="gp-counts">
          <span>
            {/* A channel shows its space's membership — its own counter only
                tracks lazily materialized rows and reads as nonsense. */}
            {scope.memberCount} member{scope.memberCount === 1 ? '' : 's'}
          </span>
          {hereCount > 0 && (
            <span className="gp-here">
              <Icon name="users" size={12} /> {hereCount} here now
            </span>
          )}
        </div>
      </div>

      {!isDm && (
        <div className="gp-tabs">
          <button
            className={`gp-tab ${tab === 'about' ? 'active' : ''}`}
            onClick={() => setTab('about')}
          >
            About
          </button>
          <button
            className={`gp-tab ${tab === 'media' ? 'active' : ''}`}
            onClick={() => setTab('media')}
          >
            Media
          </button>
        </div>
      )}

      {error && <div className="grp-error">{error}</div>}

      {tab === 'media' && !isDm ? (
        <MediaWall conversation={conversation} />
      ) : (
        <>
          {isGroup && <PetCard conversation={conversation} canName={canManage || isOwner} />}

          <div className="gp-section">
            <div className="gp-section-title">Actions</div>
            <div className="gp-actions">
              {!isDm && (
                <button className="gp-action" onClick={() => setPanel('invites')}>
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
              {/* Hiding is not tidying: it takes the room out of every list on
                  every device and holds its notifications. Settings is where
                  it comes back, behind the app lock if one is set. */}
              <button
                className="gp-action"
                onClick={() =>
                  void patchState({ isHidden: !hidden }, (s) => {
                    s.isHidden = !hidden;
                  }).then(() => {
                    if (!hidden) onClose();
                  })
                }
              >
                <Icon name="lock" size={16} /> {hidden ? 'Unhide' : 'Hide this chat'}
                {hidden && <span className="gp-action-state">hidden</span>}
              </button>
              {!isDm && (
                <button className="gp-action" onClick={() => setPanel('stickers')}>
                  <Glyph name="bag" size={16} /> Sticker store
                </button>
              )}
              {!isDm && (
                <button className="gp-action" onClick={() => setPanel('emoji')}>
                  <Icon name="smile" size={16} /> Group emoji
                </button>
              )}
              <button className="gp-action" onClick={() => void copyId(spaceScopedId)}>
                <Icon name="copy" size={16} /> {isChannel ? 'Copy space id' : 'Copy group id'}
                {copiedId && <span className="gp-action-state">copied</span>}
              </button>
              {isChannel && devModeEnabled() && (
                <button className="gp-action" onClick={() => void copyId(conversation.id)}>
                  <Icon name="copy" size={16} /> Copy channel id
                </button>
              )}
            </div>
          </div>

          {!isDm && (canManage || canRoles || canBan || isOwner) && (
            <div className="gp-section">
              <div className="gp-section-title">Manage</div>
              <div className="gp-actions">
                {isChannel && (
                  <button className="gp-action" onClick={() => setPanel('spaceOverview')}>
                    <Icon name="sparkle" size={16} /> Space overview
                  </button>
                )}
                {isChannel && canManage && (
                  <button className="gp-action" onClick={() => setPanel('spaceSettings')}>
                    <Icon name="settings" size={16} /> Space settings
                  </button>
                )}
                {canManage && (
                  <button className="gp-action" onClick={() => setPanel('settings')}>
                    <Icon name="settings" size={16} />{' '}
                    {isChannel ? 'Channel settings' : 'Group settings'}
                  </button>
                )}
                {canRoles && (
                  <button className="gp-action" onClick={() => setPanel('roles')}>
                    <Icon name="shield" size={16} /> Roles
                  </button>
                )}
                {canBan && (
                  <button className="gp-action" onClick={() => setPanel('bans')}>
                    <Glyph name="ban" size={16} /> Banned
                  </button>
                )}
                {(isOwner || has(perms, Permission.ADMINISTRATOR)) && !scope.badge && (
                  <button className="gp-action" onClick={() => setPanel('verify')}>
                    <Icon name="check" size={16} /> Request verification
                  </button>
                )}
                {isOwner && isGroup && !isCampfire && (
                  <button className="gp-action" onClick={() => setPanel('upgrade')}>
                    <Icon name="sparkle" size={16} /> Turn into a space
                  </button>
                )}
                {isOwner && (
                  <button className="gp-action" onClick={() => setPanel('transfer')}>
                    <Glyph name="swap" size={16} /> Transfer ownership
                  </button>
                )}
              </div>
            </div>
          )}

          {!isDm && (
            <div className="gp-section">
              <div className="gp-actions">
                <button className="gp-action danger" disabled={busy} onClick={() => void leave()}>
                  <Icon name="logout" size={16} />
                  {myRole === 'owner'
                    ? isChannel
                      ? 'Delete space'
                      : 'Delete group'
                    : isChannel
                      ? 'Leave space'
                      : 'Leave group'}
                </button>
              </div>
            </div>
          )}

          <div className="gp-section">
            <div className="gp-section-title">
              Members{members.length > 0 ? ` — ${members.length}` : ''}
            </div>
            <div className="gp-members">
              {membersLoading && <div className="grp-hint">Loading members…</div>}
              {members.map((m) => {
                const name = m.nickname ?? m.user.displayName ?? m.user.username ?? 'Someone';
                const online = state.online.has(m.user.id);
                const canTouch =
                  (canRoles || canBan) && m.user.id !== me?.id && m.role !== 'owner';
                const tool = memberTool?.userId === m.user.id ? memberTool.tool : null;
                // Affiliation lends the group's badge to a person: verified
                // groups only, owner/admin only — the server holds both lines,
                // this mirrors them. The owner and yourself are fair targets.
                const canAffiliate =
                  Boolean(scope.badge) &&
                  (isOwner || has(perms, Permission.ADMINISTRATOR));
                return (
                  <div key={m.user.id}>
                    <div className="gp-member">
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
                            style={{
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {name}
                          </span>
                          <IdentityMarks user={m.user} size={13} />
                          {m.role === 'owner' && (
                            <span
                              className="gp-crown"
                              title="Owner"
                              style={{ color: 'var(--yellow)' }}
                            >
                              <Icon name="crown" size={13} />
                            </span>
                          )}
                        </div>
                        {m.user.username && <div className="gp-member-sub">@{m.user.username}</div>}
                      </div>
                      {m.role !== 'member' && m.role !== 'owner' && (
                        <span className="gp-role">{m.role}</span>
                      )}
                      {m.isAffiliate && <span className="gp-role affiliate">affiliate</span>}
                      {(canTouch || canAffiliate) && (
                        <div className="gp-member-tools">
                          {canAffiliate && (
                            <button
                              className="inv-btn"
                              title={
                                m.isAffiliate
                                  ? 'Remove affiliation'
                                  : 'Affiliate — lends them the group badge'
                              }
                              style={m.isAffiliate ? { color: 'var(--accent-soft)' } : undefined}
                              onClick={() => {
                                void (async () => {
                                  try {
                                    await api(
                                      `/conversations/${spaceScopedId}/members/${m.user.id}`,
                                      { method: 'PATCH', body: { isAffiliate: !m.isAffiliate } },
                                    );
                                    setMembers((list) =>
                                      list.map((x) =>
                                        x.user.id === m.user.id
                                          ? { ...x, isAffiliate: !m.isAffiliate }
                                          : x,
                                      ),
                                    );
                                  } catch {
                                    setError('Could not change affiliation');
                                  }
                                })();
                              }}
                            >
                              <Icon name="sparkle" size={13} />
                            </button>
                          )}
                          {canTouch && canRoles && (
                            <button
                              className="inv-btn"
                              title="Roles"
                              onClick={() => {
                                setBanReason('');
                                setMemberTool(
                                  tool === 'roles' ? null : { userId: m.user.id, tool: 'roles' },
                                );
                                void ensureRoles();
                              }}
                            >
                              <Icon name="shield" size={13} />
                            </button>
                          )}
                          {canTouch && canBan && (
                            <button
                              className="inv-btn danger"
                              title="Ban"
                              onClick={() => {
                                setBanReason('');
                                setMemberTool(
                                  tool === 'ban' ? null : { userId: m.user.id, tool: 'ban' },
                                );
                              }}
                            >
                              <Glyph name="ban" size={13} />
                            </button>
                          )}
                        </div>
                      )}
                    </div>

                    {tool === 'roles' && (
                      <div className="gp-member-expand">
                        {allRoles === null ? (
                          <div className="grp-hint">Loading roles…</div>
                        ) : (
                          <MemberRolesEditor
                            conversationId={spaceScopedId}
                            userId={m.user.id}
                            allRoles={allRoles}
                            current={(m.roles ?? []).map((r) => r.id)}
                            onSaved={(roles) => {
                              setMembers((list) =>
                                list.map((x) =>
                                  x.user.id === m.user.id
                                    ? {
                                        ...x,
                                        roles,
                                        roleColor: roles.find((r) => r.color)?.color ?? null,
                                      }
                                    : x,
                                ),
                              );
                              setMemberTool(null);
                            }}
                            onError={(msg) => setError(msg)}
                          />
                        )}
                      </div>
                    )}

                    {tool === 'ban' && (
                      <div className="gp-member-expand">
                        <div className="gs-sub">
                          Ban {name}? They are removed and cannot rejoin.
                        </div>
                        <input
                          value={banReason}
                          placeholder="Reason (optional)"
                          maxLength={300}
                          onChange={(e) => setBanReason(e.target.value)}
                        />
                        <div className="gs-choices">
                          <button className="gs-choice" onClick={() => setMemberTool(null)}>
                            Cancel
                          </button>
                          <button className="gs-choice danger" onClick={() => void banMember(m)}>
                            Ban
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      {panel === 'invites' && (
        // Invites admit people to the space; a channel-scoped invite would
        // add a member row to one channel and no membership anywhere real.
        <InvitePanel conversation={scope} onClose={() => setPanel(null)} />
      )}
      {panel === 'settings' && (
        <GroupSettingsPanel conversation={conversation} onClose={() => setPanel(null)} />
      )}
      {panel === 'spaceSettings' && parentSpace && (
        // The deep settings of the CONTAINER: flair, history visibility,
        // retention defaults — the space's own, not this channel's.
        <GroupSettingsPanel conversation={parentSpace} onClose={() => setPanel(null)} />
      )}
      {panel === 'spaceOverview' && parentSpace && (
        <SpaceOverview
          space={parentSpace}
          onClose={() => setPanel(null)}
          onSelectChannel={(id) => {
            setPanel(null);
            onClose();
            void selectConversation(id);
          }}
        />
      )}
      {panel === 'roles' && (
        <RolesPanel
          conversation={scope}
          actorPerms={perms}
          isOwner={isOwner}
          onClose={() => {
            setPanel(null);
            setAllRoles(null); // the roster editors refetch a fresh list
          }}
        />
      )}
      {panel === 'bans' && <BansPanel conversation={scope} onClose={() => setPanel(null)} />}
      {panel === 'transfer' && me && (
        <TransferOwnership
          conversation={scope}
          members={members}
          myId={me.id}
          onDone={() => {
            setPanel(null);
            // Roles changed server-side (owner → admin, target → owner);
            // refetch rather than guessing.
            void (async () => {
              try {
                const res = await api<{ members: MemberView[] }>(
                  `/conversations/${conversation.id}/members?limit=100`,
                );
                setMembers(res.members);
              } catch {
                /* next open refreshes it */
              }
            })();
          }}
          onClose={() => setPanel(null)}
        />
      )}
      {panel === 'verify' && (
        // From a channel, verification is for the space that holds it.
        <VerificationWizard
          conversation={parentSpace ?? conversation}
          onClose={() => setPanel(null)}
        />
      )}
      {panel === 'emoji' && (
        <EmojiManager
          conversation={scope}
          canManage={canStickers}
          onClose={() => setPanel(null)}
        />
      )}
      {panel === 'stickers' && <StickerStore onClose={() => setPanel(null)} />}
      {panel === 'upgrade' && (
        <UpgradeToSpace conversation={conversation} onClose={() => setPanel(null)} />
      )}
    </aside>
  );
}
