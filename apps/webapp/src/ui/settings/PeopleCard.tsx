import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { Avatar } from '../Avatar';
import { ProfileIcon } from '../profile/profileIcons';

/**
 * The follow graph, from your side of it: who follows you, who you follow.
 * GET /social/me/followers and /me/following both answer
 * `{ users: (PublicUser & { isMutual })[], nextCursor }` — `isMutual` is what
 * separates "Follow back" from "Friends".
 */

interface GraphUser {
  id: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  isBot: boolean;
  isVerified: boolean;
  isMutual: boolean;
}

type Tab = 'followers' | 'following';

interface TabState {
  users: GraphUser[];
  nextCursor: string | null;
  loaded: boolean;
  error: boolean;
}

const emptyTab = (): TabState => ({ users: [], nextCursor: null, loaded: false, error: false });

export function PeopleCard() {
  const [tab, setTab] = useState<Tab>('followers');
  const [tabs, setTabs] = useState<Record<Tab, TabState>>({
    followers: emptyTab(),
    following: emptyTab(),
  });
  const [busyId, setBusyId] = useState<string | null>(null);

  const patchTab = (which: Tab, changes: Partial<TabState>) =>
    setTabs((t) => ({ ...t, [which]: { ...t[which], ...changes } }));

  const load = async (which: Tab, cursor?: string | null) => {
    try {
      const res = await api<{ users: GraphUser[]; nextCursor: string | null }>(
        `/social/me/${which}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      setTabs((t) => ({
        ...t,
        [which]: {
          users: cursor ? [...t[which].users, ...res.users] : res.users,
          nextCursor: res.nextCursor,
          loaded: true,
          error: false,
        },
      }));
    } catch {
      patchTab(which, { loaded: true, error: true });
    }
  };

  useEffect(() => {
    if (!tabs[tab].loaded) void load(tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  /** Follow back (from followers) — flips the row mutual everywhere we hold it. */
  const follow = async (userId: string) => {
    setBusyId(userId);
    try {
      const res = await api<{ following: boolean; isMutual: boolean }>(`/social/follow/${userId}`, {
        method: 'POST',
      });
      setTabs((t) => ({
        followers: {
          ...t.followers,
          users: t.followers.users.map((u) => (u.id === userId ? { ...u, isMutual: res.isMutual } : u)),
        },
        // The following list is now stale — refetch lazily next time it opens.
        following: { ...t.following, loaded: false },
      }));
    } catch {
      /* the row keeps its old state; the next load tells the truth */
    } finally {
      setBusyId(null);
    }
  };

  const unfollow = async (userId: string) => {
    setBusyId(userId);
    try {
      await api<{ following: boolean }>(`/social/follow/${userId}`, { method: 'DELETE' });
      setTabs((t) => ({
        followers: {
          ...t.followers,
          users: t.followers.users.map((u) => (u.id === userId ? { ...u, isMutual: false } : u)),
        },
        following: {
          ...t.following,
          users: t.following.users.filter((u) => u.id !== userId),
        },
      }));
    } catch {
      /* keep the row */
    } finally {
      setBusyId(null);
    }
  };

  const current = tabs[tab];

  return (
    <div className="stg-card">
      <div className="stg-card-h">People</div>
      <div className="stg-tabs" role="tablist">
        {(['followers', 'following'] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={`stg-tab${tab === t ? ' selected' : ''}`}
            onClick={() => setTab(t)}
          >
            {t === 'followers' ? 'Followers' : 'Following'}
          </button>
        ))}
      </div>

      {!current.loaded && <div className="stg-people-empty">Loading…</div>}
      {current.loaded && current.error && (
        <div className="stg-people-empty">
          That list did not load.{' '}
          <button className="stg-link-btn" onClick={() => void load(tab)}>
            Retry
          </button>
        </div>
      )}
      {current.loaded && !current.error && current.users.length === 0 && (
        <div className="stg-people-empty">
          {tab === 'followers' ? 'Nobody follows you yet.' : 'You are not following anyone yet.'}
        </div>
      )}

      {current.users.map((u) => (
        <div key={u.id} className="stg-person-row">
          <Avatar kind="person" name={u.displayName ?? u.username} url={u.avatarUrl} size={36} />
          <div className="stg-person-names">
            <div className="stg-person-name">{u.displayName ?? u.username ?? 'Someone'}</div>
            <div className="stg-person-sub">
              {u.username ? `@${u.username}` : ''}
              {u.isMutual ? ' · you follow each other' : ''}
            </div>
          </div>
          {tab === 'followers' ? (
            u.isMutual ? (
              <button
                className="stg-person-btn ghost"
                disabled={busyId === u.id}
                onClick={() => void unfollow(u.id)}
                title="Unfollow"
              >
                <ProfileIcon name="user-check" size={15} />
                Friends
              </button>
            ) : (
              <button
                className="stg-person-btn accent"
                disabled={busyId === u.id}
                onClick={() => void follow(u.id)}
              >
                <ProfileIcon name="user-plus" size={15} />
                Follow back
              </button>
            )
          ) : (
            <button
              className="stg-person-btn ghost"
              disabled={busyId === u.id}
              onClick={() => void unfollow(u.id)}
            >
              Unfollow
            </button>
          )}
        </div>
      ))}

      {current.nextCursor && (
        <button className="stg-link-btn stg-more" onClick={() => void load(tab, current.nextCursor)}>
          Show more
        </button>
      )}
    </div>
  );
}
