import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { Conversation } from '../../lib/types';
import { Icon } from '../icons';
import './group.css';

/**
 * Invite management for a group.
 *
 * Wire shapes (apps/api/src/routes/conversations.ts):
 *   POST   /v1/conversations/:id/invites        { maxUses?, expiresInSeconds? }
 *          → 201 { invite: { code, url, maxUses, uses, expiresAt } }
 *   GET    /v1/conversations/:id/invites        → { invites: [...] + createdAt }
 *   DELETE /v1/conversations/:id/invites/:code  → { revoked: true }
 *
 * All three require MANAGE_INVITES on the conversation; a 403 lands in the
 * error line. maxUses 0 means unlimited.
 */

interface InviteInfo {
  code: string;
  url: string;
  maxUses: number;
  uses: number;
  expiresAt: string | null;
  createdAt?: string;
  /** The role this link hands to whoever redeems it, if any. */
  role?: { id: string; name: string; color: string | null } | null;
}

function inviteUrl(invite: InviteInfo): string {
  return invite.url || `https://yappy.gg/join/${invite.code}`;
}

function metaOf(invite: InviteInfo): string {
  // The grant leads: it is the one thing about a link that changes what
  // redeeming it means.
  const grant = invite.role ? `grants ${invite.role.name} — ` : '';
  const uses = grant + (invite.maxUses > 0 ? `${invite.uses}/${invite.maxUses} uses` : `${invite.uses} uses`);
  if (!invite.expiresAt) return uses;
  const left = Date.parse(invite.expiresAt) - Date.now();
  if (left <= 0) return `${uses} — expired`;
  const hours = Math.round(left / 3_600_000);
  return `${uses} — expires in ${hours < 1 ? 'under an hour' : hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`}`;
}

export function InvitePanel(props: { conversation: Conversation; onClose: () => void }) {
  const { conversation, onClose } = props;
  const [invites, setInvites] = useState<InviteInfo[]>([]);
  /**
   * The space's roles, for the grants-a-role picker. Fetched lazily on
   * first open and empty in a DM, where the endpoint answers nothing.
   */
  const [roles, setRoles] = useState<Array<{ id: string; name: string; color: string | null }>>([]);
  const [grantRoleId, setGrantRoleId] = useState<string | ''>('');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
        const res = await api<{ invites: InviteInfo[] }>(`/conversations/${conversation.id}/invites`);
        if (!cancelled) setInvites(res.invites);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load invites');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversation.id]);

  useEffect(() => {
    let cancelled = false;
    api<{ roles: Array<{ id: string; name: string; color: string | null }> }>(
      `/conversations/${conversation.id}/roles`,
    )
      .then((res) => {
        if (!cancelled) setRoles(res.roles);
      })
      .catch(() => {
        /* a DM, or no permission — the picker simply does not render */
      });
    return () => {
      cancelled = true;
    };
  }, [conversation.id]);

  const create = async (): Promise<void> => {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      const res = await api<{ invite: InviteInfo }>(`/conversations/${conversation.id}/invites`, {
        method: 'POST',
        body: grantRoleId ? { roleId: grantRoleId } : {},
      });
      setInvites((list) => [res.invite, ...list]);
      await copy(res.invite);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create an invite');
    } finally {
      setCreating(false);
    }
  };

  const copy = async (invite: InviteInfo): Promise<void> => {
    try {
      await navigator.clipboard.writeText(inviteUrl(invite));
      setCopied(invite.code);
      setTimeout(() => setCopied((c) => (c === invite.code ? null : c)), 1500);
    } catch {
      /* clipboard denied — the link is still visible to select by hand */
    }
  };

  const revoke = async (code: string): Promise<void> => {
    try {
      await api<{ revoked: boolean }>(`/conversations/${conversation.id}/invites/${code}`, {
        method: 'DELETE',
      });
      setInvites((list) => list.filter((i) => i.code !== code));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not revoke that invite');
    }
  };

  return (
    <div className="grp-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="grp-modal" role="dialog" aria-label="Invite people">
        <div className="grp-modal-head">
          <div className="grp-modal-title">Invite to {conversation.title ?? 'this group'}</div>
          <button className="grp-close" onClick={onClose} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </div>

        {error && <div className="grp-error">{error}</div>}

        {/*
          What the next link will hand out. A select rather than checkboxes:
          one role per link keeps "who did this admit as what" answerable,
          and a second role is a second link.
        */}
        {roles.length > 0 && (
          <label className="inv-role-pick">
            <span>New links grant</span>
            <select value={grantRoleId} onChange={(e) => setGrantRoleId(e.target.value)}>
              <option value="">no role</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <button className="btn-accent inv-create" disabled={creating} onClick={() => void create()}>
          {creating ? 'Creating…' : 'Create invite link'}
        </button>

        <div className="inv-list">
          {loading && <div className="grp-hint">Loading invites…</div>}
          {!loading && invites.length === 0 && (
            <div className="grp-hint">No active invites. Create one and share the link.</div>
          )}
          {invites.map((invite) => (
            <div key={invite.code} className="inv-row">
              <Icon name="link" size={15} style={{ color: 'var(--text-3)', flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="inv-link">{inviteUrl(invite)}</div>
                <div className="inv-meta">{metaOf(invite)}</div>
              </div>
              <button className="inv-btn" onClick={() => void copy(invite)}>
                {copied === invite.code ? (
                  <Icon name="check" size={14} />
                ) : (
                  <Icon name="copy" size={14} />
                )}
              </button>
              <button
                className="inv-btn danger"
                title="Revoke"
                onClick={() => void revoke(invite.code)}
              >
                <Icon name="trash" size={14} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
