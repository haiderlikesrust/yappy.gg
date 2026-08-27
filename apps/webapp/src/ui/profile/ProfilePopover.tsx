import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { Avatar } from '../Avatar';
import { Icon } from '../icons';
import './profile.css';

/**
 * A floating profile card for any user id — what opens when an avatar or
 * @mention is clicked. Fetches GET /users/:id (the FullUser shape from
 * apps/api/src/lib/serialize.ts) itself, so a caller only needs an id.
 *
 * With `anchor` it floats near those viewport coordinates, clamped on-screen;
 * without one it sits centred over a dimmed backdrop.
 */

interface MutualGroups {
  count: number;
  preview: Array<{ id: string; title: string | null; emoji: string | null }>;
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
  bio: string | null;
  pronouns: string | null;
  flair: { gradient?: string[] } | null;
  presence: { status: string; customStatus: string | null; lastSeenAt: string | null };
  relationship?: { following: boolean; followedBy: boolean; isMutual: boolean };
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

const BADGE_LABEL: Record<string, string> = {
  verified: 'Verified',
  staff: 'Staff',
  partner: 'Partner',
  og: 'OG yapper',
  beta: 'Beta tester',
  bot_dev: 'Bot developer',
};

function bannerStyle(user: FullUser): React.CSSProperties | undefined {
  const g = user.flair?.gradient;
  if (g && g.length === 2) return { background: `linear-gradient(135deg, ${g[0]}, ${g[1]})` };
  return undefined;
}

export function ProfilePopover(props: {
  userId: string;
  /** Viewport coordinates to float near; omit for a centred modal. */
  anchor?: { x: number; y: number };
  onClose: () => void;
}) {
  const [user, setUser] = useState<FullUser | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(false);
    api<{ user: FullUser }>(`/users/${props.userId}`)
      .then((res) => {
        if (!cancelled) setUser(res.user);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [props.userId, attempt]);

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
  }, [props.anchor, user, error]);

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
              {user.isVerified && (
                <span className="pp-verified" title="Verified">
                  <Icon name="check" size={16} />
                </span>
              )}
              {user.isBot && <span className="pp-badge bot">Bot</span>}
              {badges.map((b) => (
                <span key={b} className="pp-badge">
                  {BADGE_LABEL[b] ?? b}
                </span>
              ))}
            </div>
            {user.username && <div className="pp-handle">@{user.username}</div>}
            {user.pronouns && <div className="pp-pronouns">{user.pronouns}</div>}

            {(user.presence.customStatus || PRESENCE_LABEL[user.presence.status]) && (
              <div className="pp-status">
                <span className="pp-status-dot" style={{ background: presenceColor }} />
                <span>{user.presence.customStatus ?? PRESENCE_LABEL[user.presence.status]}</span>
              </div>
            )}

            {user.bio && <div className="pp-bio">{user.bio}</div>}

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

            {user.relationship?.followedBy && (
              <div className="pp-relationship">
                {user.relationship.isMutual ? 'You follow each other' : 'Follows you'}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );

  return (
    <div className={`pp-backdrop${anchored ? '' : ' dim'}`} onClick={props.onClose}>
      {card}
    </div>
  );
}
