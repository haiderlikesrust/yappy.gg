import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import type { Conversation, PublicUser } from '../../lib/types';
import { mutate, selectConversation } from '../../state/store';
import { Avatar } from '../Avatar';
import { BADGE_DESCRIPTION, BADGE_LABEL, BadgeMark, IdentityMarks } from '../badges';
import { Icon } from '../icons';
import { ProfileIcon } from './profileIcons';
import { ReportModal } from './ReportModal';
import { SafetyNumber } from './SafetyNumber';
import './profile.css';

/**
 * A floating profile card for any user id — what opens when an avatar or
 * @mention is clicked. Fetches GET /users/:id (the FullUser shape from
 * apps/api/src/lib/serialize.ts) itself, so a caller only needs an id.
 *
 * With `anchor` it floats near those viewport coordinates, clamped on-screen;
 * without one it sits centred over a dimmed backdrop.
 *
 * When the server sends a `relationship` (i.e. this is somebody else), the
 * card grows actions: follow/unfollow, message (create-or-open the DM),
 * block/unblock and report. Whether they are already blocked comes from
 * GET /social/blocks — the profile payload does not carry it.
 */

interface MutualGroups {
  count: number;
  preview: Array<{ id: string; title: string | null; emoji: string | null }>;
}

/**
 * What one group knows about somebody: the group-scoped half of a profile.
 *
 * `GET /users/:id` answers who they are everywhere and knows nothing about
 * any group — so a card opened from a chat could say what they are called
 * and not what they *are* in the room you are both standing in.
 */
interface GroupMembership {
  role: string;
  roles: Array<{ id: string; name: string; color: string | null }>;
  nickname: string | null;
  joinedAt: string;
}

interface Relationship {
  following: boolean;
  followedBy: boolean;
  isMutual: boolean;
}

interface FullUser {
  id: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  bannerUrl: string | null;
  isBot: boolean;
  isVerified: boolean;
  badge: string | null;
  badges: string[];
  affiliation?: PublicUser['affiliation'];
  bio: string | null;
  pronouns: string | null;
  flair: { gradient?: string[] } | null;
  presence: { status: string; customStatus: string | null; lastSeenAt: string | null };
  relationship?: Relationship;
  mutualGroups?: MutualGroups;
  createdAt: string;
}

const PRESENCE_COLOR: Record<string, string> = {
  online: 'var(--green)',
  idle: '#f5a524',
  dnd: 'var(--danger)',
};

const PRESENCE_LABEL: Record<string, string> = {
  online: 'Online',
  idle: 'Idle',
  dnd: 'Do not disturb',
};

function bannerStyle(user: FullUser): React.CSSProperties | undefined {
  const g = user.flair?.gradient;
  if (g && g.length === 2) return { background: `linear-gradient(135deg, ${g[0]}, ${g[1]})` };
  return undefined;
}

/** Follow / Follow back / Following / Friends, from both edges of the graph. */
function followLabel(rel: Relationship): string {
  if (rel.isMutual) return 'Friends';
  if (rel.following) return 'Following';
  if (rel.followedBy) return 'Follow back';
  return 'Follow';
}

export function ProfilePopover(props: {
  userId: string;
  /**
   * The conversation this card was opened from, if any.
   *
   * With one, the card also shows what this group knows about them —
   * their roles here, and when they joined. Without one (a search result,
   * a follower list) it stays the global profile it has always been.
   */
  conversationId?: string;
  /** Viewport coordinates to float near; omit for a centred modal. */
  anchor?: { x: number; y: number };
  onClose: () => void;
}) {
  const [user, setUser] = useState<FullUser | null>(null);
  const [membership, setMembership] = useState<GroupMembership | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // ── Actions state ──────────────────────────────────────────────────────────
  const [rel, setRel] = useState<Relationship | null>(null);
  /** null until GET /social/blocks answers — the buttons wait for the truth. */
  const [blocked, setBlocked] = useState<boolean | null>(null);
  const [followBusy, setFollowBusy] = useState(false);
  const [dmBusy, setDmBusy] = useState(false);
  const [blockBusy, setBlockBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [safetyOpen, setSafetyOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setError(false);
    setActionError(null);
    api<{ user: FullUser }>(`/users/${props.userId}`)
      .then((res) => {
        if (cancelled) return;
        setUser(res.user);
        setRel(res.user.relationship ?? null);
        if (res.user.relationship) {
          // Someone else's profile — find out whether we already block them.
          api<{ users: Array<{ id: string }> }>('/social/blocks')
            .then((b) => {
              if (!cancelled) setBlocked(b.users.some((u) => u.id === res.user.id));
            })
            .catch(() => {
              if (!cancelled) setBlocked(false);
            });
        }
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    /*
     * A separate request, and a silent failure.
     *
     * Not being a member is an ordinary answer — a card can be opened on
     * somebody who has since left, or from a DM, which has no roles to
     * speak of. The section simply does not appear.
     */
    if (props.conversationId) {
      api<{ member: GroupMembership }>(
        `/conversations/${props.conversationId}/members/${props.userId}`,
      )
        .then((res) => {
          if (!cancelled) setMembership(res.member);
        })
        .catch(() => {
          if (!cancelled) setMembership(null);
        });
    } else {
      setMembership(null);
    }

    return () => {
      cancelled = true;
    };
  }, [props.userId, props.conversationId, attempt]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props]);

  // Clamp the anchored card inside the viewport once its real height is known.
  // Re-runs when the content changes shape (loading → loaded).
  useLayoutEffect(() => {
    if (!props.anchor || !cardRef.current) return;
    const { width, height } = cardRef.current.getBoundingClientRect();
    const margin = 12;
    const left = Math.min(Math.max(props.anchor.x, margin), window.innerWidth - width - margin);
    const top = Math.min(Math.max(props.anchor.y, margin), window.innerHeight - height - margin);
    setPos({ left, top });
  }, [props.anchor, user, error, blocked]);

  const toggleFollow = async () => {
    if (!rel || followBusy) return;
    setFollowBusy(true);
    setActionError(null);
    try {
      if (rel.following) {
        await api<{ following: boolean }>(`/social/follow/${props.userId}`, { method: 'DELETE' });
        setRel({ ...rel, following: false, isMutual: false });
      } else {
        const res = await api<{ following: boolean; isMutual: boolean }>(
          `/social/follow/${props.userId}`,
          { method: 'POST' },
        );
        setRel({ ...rel, following: res.following, isMutual: res.isMutual });
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'That did not work. Try again.');
    } finally {
      setFollowBusy(false);
    }
  };

  const openDm = async () => {
    if (dmBusy) return;
    setDmBusy(true);
    setActionError(null);
    try {
      // Create-or-open: the server answers 200 with the existing DM when
      // there is one, 201 with a fresh conversation otherwise.
      const res = await api<{ conversation: Conversation }>('/conversations', {
        method: 'POST',
        body: { type: 'dm', memberIds: [props.userId] },
      });
      mutate((s) => {
        const existing = s.conversations.get(res.conversation.id);
        s.conversations.set(
          res.conversation.id,
          existing ? { ...existing, ...res.conversation } : res.conversation,
        );
      });
      props.onClose();
      await selectConversation(res.conversation.id);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not open that conversation.');
      setDmBusy(false);
    }
  };

  const toggleBlock = async () => {
    if (blocked === null || blockBusy) return;
    setBlockBusy(true);
    setActionError(null);
    try {
      if (blocked) {
        await api<{ blocked: boolean }>(`/social/block/${props.userId}`, { method: 'DELETE' });
        setBlocked(false);
      } else {
        await api<{ blocked: boolean }>('/social/block', {
          method: 'POST',
          body: { userId: props.userId },
        });
        setBlocked(true);
        // The server's trigger severs follows both ways; mirror that here.
        setRel((r) => (r ? { ...r, following: false, followedBy: false, isMutual: false } : r));
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'That did not work. Try again.');
    } finally {
      setBlockBusy(false);
    }
  };

  const anchored = Boolean(props.anchor);
  const presenceColor = user ? (PRESENCE_COLOR[user.presence.status] ?? 'var(--text-3)') : undefined;
  const badges = user ? (user.badges.length > 0 ? user.badges : user.badge ? [user.badge] : []) : [];

  const card = (
    <div
      ref={cardRef}
      className={`pp-card${anchored ? ' anchored' : ''}`}
      role="dialog"
      aria-label="Profile"
      style={
        anchored
          ? (pos ?? { left: props.anchor!.x, top: props.anchor!.y, visibility: 'hidden' })
          : undefined
      }
      onClick={(e) => e.stopPropagation()}
    >
      {error && (
        <div className="pp-state">
          That profile did not load.
          <div>
            <button className="btn-accent" onClick={() => setAttempt((n) => n + 1)}>
              Retry
            </button>
          </div>
        </div>
      )}
      {!error && !user && <div className="pp-state">Loading…</div>}
      {user && (
        <>
          <div className="pp-banner" style={bannerStyle(user)}>
            {user.bannerUrl && <img src={user.bannerUrl} alt="" />}
            <div className="pp-avatar-ring">
              <Avatar kind="person" name={user.displayName ?? user.username} url={user.avatarUrl} size={56} />
              <span className="pp-presence-dot" style={{ background: presenceColor }} />
            </div>
          </div>
          <div className="pp-body">
            <div className="pp-name-line">
              <span className="pp-name">{user.displayName ?? user.username ?? 'Someone'}</span>
              <IdentityMarks user={user} size={16} />
            </div>
            {user.username && <div className="pp-handle">@{user.username}</div>}
            {user.pronouns && <div className="pp-pronouns">{user.pronouns}</div>}

            {/* The profile is where a mark gets to explain itself. */}
            {badges.length > 0 && (
              <div className="pp-badge-list">
                {badges.map((b) =>
                  BADGE_LABEL[b] ? (
                    <div key={b} className="pp-badge-row">
                      <BadgeMark badge={b} size={15} />
                      <span className="pp-badge-label">{BADGE_LABEL[b]}</span>
                      <span className="pp-badge-desc">{BADGE_DESCRIPTION[b]}</span>
                    </div>
                  ) : null,
                )}
              </div>
            )}

            {rel && (
              <div className="pp-actions">
                {blocked !== true && (
                  <>
                    <button
                      className={`pp-btn${rel.following ? ' ghost' : ' accent'}`}
                      disabled={followBusy || blocked === null}
                      onClick={() => void toggleFollow()}
                      title={rel.following ? 'Unfollow' : 'Follow'}
                    >
                      <ProfileIcon name={rel.following ? 'user-check' : 'user-plus'} size={16} />
                      {followBusy ? '…' : followLabel(rel)}
                    </button>
                    <button
                      className="pp-btn ghost"
                      disabled={dmBusy}
                      onClick={() => void openDm()}
                    >
                      <Icon name="chat" size={16} />
                      {dmBusy ? 'Opening…' : 'Message'}
                    </button>
                  </>
                )}
                {blocked === true && (
                  <button
                    className="pp-btn ghost"
                    disabled={blockBusy}
                    onClick={() => void toggleBlock()}
                  >
                    <ProfileIcon name="ban" size={16} />
                    {blockBusy ? '…' : 'Unblock'}
                  </button>
                )}
                <span className="pp-actions-spacer" />
                {blocked !== true && (
                  <button
                    className="pp-icon-btn danger"
                    title="Block"
                    aria-label="Block"
                    disabled={blockBusy || blocked === null}
                    onClick={() => void toggleBlock()}
                  >
                    <ProfileIcon name="ban" size={17} />
                  </button>
                )}
                <button
                  className="pp-icon-btn"
                  title="Safety number"
                  aria-label="Safety number"
                  onClick={() => setSafetyOpen(true)}
                >
                  <Icon name="shield" size={17} />
                </button>
                <button
                  className="pp-icon-btn danger"
                  title="Report"
                  aria-label="Report"
                  onClick={() => setReportOpen(true)}
                >
                  <ProfileIcon name="flag" size={17} />
                </button>
              </div>
            )}
            {blocked === true && (
              <div className="pp-blocked-note">
                Blocked — they cannot follow you or message you.
              </div>
            )}
            {actionError && <div className="pp-action-error">{actionError}</div>}

            {user.presence.customStatus || PRESENCE_LABEL[user.presence.status] ? (
              <div className="pp-status">
                <span className="pp-status-dot" style={{ background: presenceColor }} />
                <span>{user.presence.customStatus ?? PRESENCE_LABEL[user.presence.status]}</span>
              </div>
            ) : null}

            {user.bio && <div className="pp-bio">{user.bio}</div>}

            {membership && membership.roles.length > 0 && (
              <>
                <div className="pp-divider" />
                <div className="pp-section-h">
                  {membership.roles.length === 1 ? 'Role' : 'Roles'}
                </div>
                <div className="pp-roles">
                  {membership.roles.map((r) => (
                    <span
                      key={r.id}
                      className="pp-role"
                      style={
                        r.color
                          ? { color: r.color, borderColor: `${r.color}66`, background: `${r.color}1a` }
                          : undefined
                      }
                    >
                      <span
                        className="pp-role-dot"
                        style={{ background: r.color ?? 'currentColor' }}
                      />
                      {r.name}
                    </span>
                  ))}
                </div>
              </>
            )}

            {user.mutualGroups && user.mutualGroups.count > 0 && (
              <>
                <div className="pp-divider" />
                <div className="pp-section-h">
                  {user.mutualGroups.count === 1
                    ? '1 group in common'
                    : `${user.mutualGroups.count} groups in common`}
                </div>
                <div className="pp-mutuals">
                  {user.mutualGroups.preview.map((g) => (
                    <div key={g.id} className="pp-mutual">
                      <span className="pp-mutual-chip">
                        {g.emoji ?? (g.title?.trim()?.[0]?.toUpperCase() ?? <Icon name="users" size={13} />)}
                      </span>
                      <span>{g.title ?? 'Untitled group'}</span>
                    </div>
                  ))}
                  {user.mutualGroups.count > user.mutualGroups.preview.length && (
                    <div className="pp-mutual-more">
                      and {user.mutualGroups.count - user.mutualGroups.preview.length} more
                    </div>
                  )}
                </div>
              </>
            )}

            {rel?.followedBy && (
              <div className="pp-relationship">
                {rel.isMutual ? 'You follow each other' : 'Follows you'}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );

  return (
    <>
      <div className={`pp-backdrop${anchored ? '' : ' dim'}`} onClick={props.onClose}>
        {card}
      </div>
      {reportOpen && user && (
        <ReportModal
          targetType="user"
          targetId={user.id}
          targetLabel={user.username ? `@${user.username}` : (user.displayName ?? 'this account')}
          onClose={() => setReportOpen(false)}
        />
      )}
      {safetyOpen && user && (
        <SafetyNumber
          userId={user.id}
          name={user.displayName ?? user.username ?? 'They'}
          onClose={() => setSafetyOpen(false)}
        />
      )}
    </>
  );
}
