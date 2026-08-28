import { useState } from 'react';
import { api } from '../../lib/api';
import { lockEnabled, verify } from '../../lib/applock';
import type { Conversation } from '../../lib/types';
import { loadConversations, mutate, selectConversation } from '../../state/store';
import { Avatar } from '../Avatar';

/**
 * Where a hidden chat comes back.
 *
 * It is deliberately the only door. Hiding takes a room out of the sidebar,
 * out of the switcher and out of every other client's list, so there has to be
 * one place that knows they exist — and that place asks for the app-lock
 * passcode first when one is set, because a list of the chats somebody hid is
 * exactly the thing they were hiding.
 *
 * With no passcode set, the list is one press away and the card says so. That
 * is honest: hiding without a lock protects against a glance, not a search.
 */
export function HiddenChatsCard() {
  const [open, setOpen] = useState(false);
  const [passcode, setPasscode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [chats, setChats] = useState<Conversation[] | null>(null);

  const reveal = async () => {
    setBusy(true);
    setError(null);
    if (lockEnabled() && !(await verify(passcode))) {
      setBusy(false);
      setError('That passcode is not right.');
      return;
    }
    try {
      const res = await api<{ conversations: Conversation[] }>('/conversations?limit=100&hidden=true');
      setChats(res.conversations);
      setOpen(true);
      setPasscode('');
    } catch {
      setError('That list did not load.');
    } finally {
      setBusy(false);
    }
  };

  const unhide = async (id: string) => {
    setBusy(true);
    try {
      await api(`/conversations/${id}/state`, { method: 'PATCH', body: { isHidden: false } });
      mutate((s) => {
        const conv = s.conversations.get(id);
        if (conv?.self) conv.self.isHidden = false;
      });
      setChats((list) => (list ? list.filter((c) => c.id !== id) : list));
      // Bring it back to the sidebar with its live summary.
      void loadConversations();
    } catch {
      /* it stays in the list, which is the truth */
    } finally {
      setBusy(false);
    }
  };

  const title = (conv: Conversation) =>
    conv.title ?? conv.otherUser?.displayName ?? conv.otherUser?.username ?? 'Chat';

  return (
    <div className="stg-card">
      <div className="stg-card-h">Hidden chats</div>
      <div className="stg-hint">
        A hidden chat is in no list, on any device, and its notifications stay quiet. This is where
        it comes back.
        {lockEnabled() ? ' Your passcode opens it.' : ' Set an app lock above to put a passcode on this list.'}
      </div>

      {!open && (
        <div className="stg-lock-form">
          {lockEnabled() && (
            <input
              className="stg-input"
              type="password"
              placeholder="Passcode"
              value={passcode}
              onChange={(e) => {
                setPasscode(e.target.value);
                setError(null);
              }}
            />
          )}
          <div className="stg-lock-actions">
            <button className="stg-person-btn" disabled={busy} onClick={() => void reveal()}>
              {busy ? 'Checking…' : 'Show hidden chats'}
            </button>
          </div>
          {error && <div className="stg-lock-error">{error}</div>}
        </div>
      )}

      {open && chats !== null && chats.length === 0 && (
        <div className="stg-people-empty">Nothing is hidden.</div>
      )}

      {open &&
        (chats ?? []).map((conv) => (
          <div key={conv.id} className="stg-person-row">
            <Avatar
              kind={conv.type === 'dm' ? 'person' : 'place'}
              name={title(conv)}
              url={conv.avatarUrl ?? conv.otherUser?.avatarUrl ?? null}
              size={36}
            />
            <div className="stg-person-names">
              <div className="stg-person-name">{title(conv)}</div>
              <div className="stg-person-sub">{conv.type === 'dm' ? 'Direct message' : conv.type}</div>
            </div>
            <button
              className="stg-person-btn ghost"
              disabled={busy}
              onClick={() => void selectConversation(conv.id)}
            >
              Open
            </button>
            <button className="stg-person-btn ghost" disabled={busy} onClick={() => void unhide(conv.id)}>
              Unhide
            </button>
          </div>
        ))}

      {open && (
        <div className="stg-lock-actions">
          <button
            className="stg-person-btn ghost"
            onClick={() => {
              setOpen(false);
              setChats(null);
            }}
          >
            Hide this list again
          </button>
        </div>
      )}
    </div>
  );
}
