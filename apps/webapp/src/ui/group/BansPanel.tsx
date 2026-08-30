import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { Conversation, PublicUser } from '../../lib/types';
import { Avatar } from '../Avatar';
import { Icon } from '../icons';
import { errText } from './groupKit';
import './group.css';

/**
 * Who was thrown out, and the way back in.
 *
 * Wire shapes (apps/api/src/routes/conversations.ts:783-853, BAN_MEMBERS):
 *   GET    /v1/conversations/:id/bans          → { bans: [{ user, reason, bannedById, expiresAt, createdAt }] }
 *   DELETE /v1/conversations/:id/bans/:userId  → { banned: false }
 * (Banning happens from the member row in GroupPanel — POST /:id/bans/:userId
 * { reason? } — because that is where the person is.)
 */

interface BanInfo {
  user: PublicUser;
  reason: string | null;
  bannedById: string;
  expiresAt: string | null;
  createdAt: string;
}

export function BansPanel(props: { conversation: Conversation; onClose: () => void }) {
  const { conversation, onClose } = props;
  const [bans, setBans] = useState<BanInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api<{ bans: BanInfo[] }>(`/conversations/${conversation.id}/bans`);
        if (!cancelled) setBans(res.bans);
      } catch (err) {
        if (!cancelled) setError(errText(err, 'Could not load the ban list'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversation.id]);

  const unban = async (userId: string): Promise<void> => {
    if (busy) return;
    setBusy(userId);
    setError(null);
    try {
      await api<{ banned: boolean }>(`/conversations/${conversation.id}/bans/${userId}`, {
        method: 'DELETE',
      });
      setBans((list) => list.filter((b) => b.user.id !== userId));
    } catch (err) {
      setError(errText(err, 'Could not lift that ban'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grp-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="grp-modal" role="dialog" aria-label="Banned members">
        <div className="grp-modal-head">
          <div className="grp-modal-title">Banned</div>
          <button className="grp-close" onClick={onClose} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </div>

        {error && <div className="grp-error">{error}</div>}

        <div className="inv-list">
          {loading && <div className="grp-hint">Loading…</div>}
          {!loading && bans.length === 0 && (
            <div className="grp-hint">Nobody is banned from this group.</div>
          )}
          {bans.map((ban) => {
            const name = ban.user.displayName ?? ban.user.username ?? 'Someone';
            return (
              <div key={ban.user.id} className="inv-row">
                <Avatar kind="person" name={name} url={ban.user.avatarUrl} size={32} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="gp-member-name">{name}</div>
                  <div className="inv-meta">
                    {ban.reason ? `“${ban.reason}”` : 'No reason recorded'}
                    {ban.expiresAt
                      ? ` — until ${new Date(ban.expiresAt).toLocaleDateString()}`
                      : ''}
                  </div>
                </div>
                <button
                  className="inv-btn"
                  disabled={busy === ban.user.id}
                  onClick={() => void unban(ban.user.id)}
                >
                  {busy === ban.user.id ? '…' : 'Unban'}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
