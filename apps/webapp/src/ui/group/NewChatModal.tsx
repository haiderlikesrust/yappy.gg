import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { Conversation } from '../../lib/types';
import { gateway, getState, mutate, selectConversation } from '../../state/store';
import { Avatar } from '../Avatar';
import { Icon } from '../icons';
import { Glyph } from './groupKit';
import './group.css';

/**
 * The "start something" overlay: find a person and open a DM, or name a group
 * and create it — optionally as a campfire, a group that burns out.
 *
 * People search rides GET /v1/search?q= (the unified box — its `users` array),
 * debounced 350ms and only from two characters. Creation is
 * POST /v1/conversations with the createConversationBody shapes:
 *   DM       { type: 'dm', memberIds: [otherUserId] }     (server dedupes; 200 returns the existing DM)
 *   group    { type: 'group', title, memberIds: [] }
 *   campfire adds campfireSeconds (positive int ≤ CAMPFIRE_MAX_SECONDS, groups
 *            only) — the whole place is deleted that many seconds from now,
 *            and the view carries `endsAt` for the countdown chip.
 * Either way the response is { conversation } — inserted into the store,
 * subscribed on the gateway and selected.
 */

const CAMPFIRE_CHOICES: Array<{ seconds: number; label: string }> = [
  { seconds: 3_600, label: '1 hour' },
  { seconds: 21_600, label: '6 hours' },
  { seconds: 86_400, label: '24 hours' },
];

interface SearchUser {
  id: string;
  username: string | null;
  displayName: string | null;
  isVerified: boolean;
  avatarUrl: string | null;
}

export function NewChatModal(props: { onClose: () => void }) {
  const { onClose } = props;
  const [tab, setTab] = useState<'person' | 'group'>('person');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchUser[]>([]);
  const [searching, setSearching] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [campfire, setCampfire] = useState(false);
  const [campfireSeconds, setCampfireSeconds] = useState(3_600);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await api<{ users?: SearchUser[] }>(`/search?q=${encodeURIComponent(term)}`);
        if (cancelled) return;
        const myId = getState().me?.id;
        setResults((res.users ?? []).filter((u) => u.id !== myId));
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const open = async (conversation: Conversation): Promise<void> => {
    mutate((s) => {
      const existing = s.conversations.get(conversation.id);
      s.conversations.set(
        conversation.id,
        existing ? { ...existing, ...conversation } : conversation,
      );
    });
    // A conversation created after IDENTIFY must be joined by hand or its
    // messages never stream (same rule the ConversationCreate handler applies).
    gateway.subscribe(conversation.id);
    await selectConversation(conversation.id);
    onClose();
  };

  const startDm = async (user: SearchUser): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ conversation: Conversation }>('/conversations', {
        method: 'POST',
        body: { type: 'dm', memberIds: [user.id] },
      });
      await open(res.conversation);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the chat');
      setBusy(false);
    }
  };

  const createGroup = async (): Promise<void> => {
    const title = groupName.trim();
    if (!title || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ conversation: Conversation }>('/conversations', {
        method: 'POST',
        body: {
          type: 'group',
          title,
          memberIds: [],
          ...(campfire ? { campfireSeconds } : {}),
        },
      });
      await open(res.conversation);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the group');
      setBusy(false);
    }
  };

  return (
    <div className="grp-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="grp-modal" role="dialog" aria-label="New chat">
        <div className="grp-modal-head">
          <div className="grp-modal-title">New chat</div>
          <button className="grp-close" onClick={onClose} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </div>

        <div className="nc-tabs">
          <button
            className={`nc-tab ${tab === 'person' ? 'active' : ''}`}
            onClick={() => setTab('person')}
          >
            Person
          </button>
          <button
            className={`nc-tab ${tab === 'group' ? 'active' : ''}`}
            onClick={() => setTab('group')}
          >
            Group
          </button>
        </div>

        {error && <div className="grp-error">{error}</div>}

        {tab === 'person' ? (
          <div className="nc-body">
            <input
              autoFocus
              value={query}
              placeholder="Search people"
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="nc-results">
              {results.map((u) => (
                <button key={u.id} className="nc-person" disabled={busy} onClick={() => void startDm(u)}>
                  <Avatar kind="person" name={u.displayName ?? u.username} url={u.avatarUrl} size={36} />
                  <div>
                    <div className="nc-person-name">
                      {u.displayName ?? u.username ?? 'Someone'}
                      {u.isVerified && (
                        <span className="nc-verified">
                          {' '}
                          <Icon name="check" size={12} />
                        </span>
                      )}
                    </div>
                    {u.username && <div className="nc-person-handle">@{u.username}</div>}
                  </div>
                </button>
              ))}
              {query.trim().length >= 2 && !searching && results.length === 0 && (
                <div className="grp-hint">Nobody found for “{query.trim()}”</div>
              )}
              {query.trim().length < 2 && (
                <div className="grp-hint">Type at least two characters to search</div>
              )}
            </div>
          </div>
        ) : (
          <div className="nc-body">
            <input
              autoFocus
              value={groupName}
              placeholder="Group name"
              maxLength={100}
              onChange={(e) => setGroupName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void createGroup()}
            />
            <button
              className={`nc-campfire ${campfire ? 'active' : ''}`}
              onClick={() => setCampfire((c) => !c)}
              aria-pressed={campfire}
            >
              <Glyph name="flame" size={16} />
              <span className="nc-campfire-main">
                <span className="nc-campfire-title">Campfire</span>
                <span className="nc-campfire-sub">
                  A group that burns out — everything disappears when time is up.
                </span>
              </span>
              <span className={`nc-toggle ${campfire ? 'on' : ''}`} aria-hidden />
            </button>
            {campfire && (
              <div className="gs-choices">
                {CAMPFIRE_CHOICES.map((opt) => (
                  <button
                    key={opt.seconds}
                    className={`gs-choice ${campfireSeconds === opt.seconds ? 'active' : ''}`}
                    onClick={() => setCampfireSeconds(opt.seconds)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
            <button
              className="btn-accent"
              disabled={!groupName.trim() || busy}
              onClick={() => void createGroup()}
            >
              {campfire ? 'Light the campfire' : 'Create group'}
            </button>
            <div className="grp-hint">You can invite people once it exists.</div>
          </div>
        )}
      </div>
    </div>
  );
}
