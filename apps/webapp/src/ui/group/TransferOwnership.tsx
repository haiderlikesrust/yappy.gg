import { useState } from 'react';
import { api } from '../../lib/api';
import type { Conversation, PublicUser } from '../../lib/types';
import { mutate } from '../../state/store';
import { Avatar } from '../Avatar';
import { Icon } from '../icons';
import { Glyph, errText } from './groupKit';
import './group.css';

/**
 * Handing the group to someone else — owner only, irreversible from this side.
 *
 * POST /v1/conversations/:id/transfer-ownership { userId } (conversations.ts:739).
 * The server demotes the caller to admin and promotes the target in one
 * transaction, so the two-step guard here (pick, then type the group's name)
 * is the entire safety margin.
 */

interface MemberLike {
  user: PublicUser;
  role: string;
}

export function TransferOwnership(props: {
  conversation: Conversation;
  members: MemberLike[];
  myId: string;
  onDone: () => void;
  onClose: () => void;
}) {
  const { conversation, members, myId, onDone, onClose } = props;
  const [picked, setPicked] = useState<MemberLike | null>(null);
  const [guard, setGuard] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const title = conversation.title ?? 'this group';
  const candidates = members.filter((m) => m.user.id !== myId && !m.user.isBot);
  const guardMatches = guard.trim() === (conversation.title ?? '').trim() && guard.trim() !== '';

  const transfer = async (): Promise<void> => {
    if (!picked || !guardMatches || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api<{ ok: boolean }>(`/conversations/${conversation.id}/transfer-ownership`, {
        method: 'POST',
        body: { userId: picked.user.id },
      });
      mutate((st) => {
        const conv = st.conversations.get(conversation.id);
        if (conv) conv.ownerId = picked.user.id;
      });
      onDone();
    } catch (err) {
      setError(errText(err, 'Could not transfer ownership'));
      setBusy(false);
    }
  };

  return (
    <div className="grp-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="grp-modal" role="dialog" aria-label="Transfer ownership">
        <div className="grp-modal-head">
          <div className="grp-modal-title">Transfer ownership</div>
          <button className="grp-close" onClick={onClose} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </div>

        {error && <div className="grp-error">{error}</div>}

        {!picked ? (
          <div className="gs-body">
            <div className="grp-hint" style={{ textAlign: 'left', padding: 0 }}>
              The new owner controls everything here — including you. You become an admin.
            </div>
            <div className="nc-results">
              {candidates.length === 0 && (
                <div className="grp-hint">Nobody else is here to take over.</div>
              )}
              {candidates.map((m) => {
                const name = m.user.displayName ?? m.user.username ?? 'Someone';
                return (
                  <button key={m.user.id} className="nc-person" onClick={() => setPicked(m)}>
                    <Avatar kind="person" name={name} url={m.user.avatarUrl} size={32} />
                    <div>
                      <div className="nc-person-name">{name}</div>
                      {m.user.username && <div className="nc-person-handle">@{m.user.username}</div>}
                    </div>
                    <span className="gp-role" style={{ marginLeft: 'auto' }}>
                      {m.role}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="gs-body">
            <div className="transfer-target">
              <Glyph name="swap" size={16} style={{ color: 'var(--warning)' }} />
              <span>
                Handing <strong>{title}</strong> to{' '}
                <strong>{picked.user.displayName ?? picked.user.username ?? 'this member'}</strong>.
              </span>
            </div>
            <div className="gs-label">Type the group name to confirm</div>
            <input
              autoFocus
              value={guard}
              placeholder={conversation.title ?? ''}
              onChange={(e) => setGuard(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void transfer()}
            />
            <div className="gs-choices">
              <button className="gs-choice" onClick={() => setPicked(null)}>
                Back
              </button>
              <button
                className="btn-accent"
                style={{ flex: 1 }}
                disabled={!guardMatches || busy}
                onClick={() => void transfer()}
              >
                {busy ? 'Transferring…' : 'Transfer ownership'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
