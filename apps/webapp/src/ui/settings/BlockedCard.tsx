import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { Avatar } from '../Avatar';

/**
 * Everyone you have blocked, with the way back. GET /social/blocks answers
 * `{ users: PublicUser[] }` (no pagination — the server sends the lot);
 * DELETE /social/block/:id lifts one.
 */

interface BlockedUser {
  id: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

export function BlockedCard() {
  const [users, setUsers] = useState<BlockedUser[] | null>(null);
  const [error, setError] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = async () => {
    setError(false);
    try {
      const res = await api<{ users: BlockedUser[] }>('/social/blocks');
      setUsers(res.users);
    } catch {
      setError(true);
      setUsers([]);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const unblock = async (userId: string) => {
    setBusyId(userId);
    try {
      await api<{ blocked: boolean }>(`/social/block/${userId}`, { method: 'DELETE' });
      setUsers((u) => (u ? u.filter((b) => b.id !== userId) : u));
    } catch {
      /* still blocked; the row stays */
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="stg-card">
      <div className="stg-card-h">Blocked</div>
      {users === null && <div className="stg-people-empty">Loading…</div>}
      {error && (
        <div className="stg-people-empty">
          That list did not load.{' '}
          <button className="stg-link-btn" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}
      {users !== null && !error && users.length === 0 && (
        <div className="stg-people-empty">You have not blocked anyone.</div>
      )}
      {(users ?? []).map((u) => (
        <div key={u.id} className="stg-person-row">
          <Avatar kind="person" name={u.displayName ?? u.username} url={u.avatarUrl} size={36} />
          <div className="stg-person-names">
            <div className="stg-person-name">{u.displayName ?? u.username ?? 'Someone'}</div>
            {u.username && <div className="stg-person-sub">@{u.username}</div>}
          </div>
          <button
            className="stg-person-btn ghost"
            disabled={busyId === u.id}
            onClick={() => void unblock(u.id)}
          >
            {busyId === u.id ? '…' : 'Unblock'}
          </button>
        </div>
      ))}
    </div>
  );
}
