import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import type { Conversation, PublicUser } from '../../lib/types';
import { useStore } from '../../state/store';
import { Avatar } from '../Avatar';
import { Icon } from '../icons';
import { BotIcon } from './botIcons';
import './bots.css';

/**
 * The bot directory: every public bot, addable to your groups.
 *
 * GET /apps/directory answers `{ bots }` where each entry carries the
 * application id AND `botUserId` — the *user* id is what joins a conversation.
 * Adding goes through the ordinary member endpoint
 * (POST /conversations/:id/members { userIds: [botUserId] }): a bot is a user
 * row, the server runs the ordinary permission check, and the group gets the
 * ordinary "X added Y" system message. There is no bot-specific add route.
 *
 * With `conversationId` the picker is skipped and every Add lands in that
 * group — pass it when opening from a group's own context.
 */

interface DirectoryBot {
  id: string;
  botUserId: string;
  name: string;
  description: string | null;
  commandCount: number;
  user: PublicUser;
}

type AddState =
  | { phase: 'idle' }
  | { phase: 'picking' }
  | { phase: 'adding'; conversationId: string }
  | { phase: 'added'; title: string }
  | { phase: 'error'; message: string };

export function BotDirectory(props: { onClose: () => void; conversationId?: string }) {
  const { state } = useStore('conversations');
  const [bots, setBots] = useState<DirectoryBot[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  /** Per-bot add flow, keyed by application id. */
  const [addStates, setAddStates] = useState<Record<string, AddState>>({});

  useEffect(() => {
    let cancelled = false;
    setLoadError(false);
    api<{ bots: DirectoryBot[] }>('/apps/directory')
      .then((res) => {
        if (!cancelled) setBots(res.bots);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props]);

  /**
   * Groups the bot could go in: real groups and spaces, not DMs and not
   * channels (a channel's roster is its space's). Whether *you* may add
   * members there is the server's call — a refusal comes back as the row's
   * error message rather than being second-guessed here.
   */
  const groups = useMemo(() => {
    const list: Conversation[] = [];
    for (const c of state.conversations.values()) {
      if ((c.type === 'group' || c.type === 'space') && !c.parentId) list.push(c);
    }
    return list.sort((a, b) => (a.title ?? '').localeCompare(b.title ?? ''));
  }, [state.conversations]);

  const setAddState = (botId: string, s: AddState) =>
    setAddStates((prev) => ({ ...prev, [botId]: s }));

  const addTo = async (bot: DirectoryBot, conversationId: string, title: string | null) => {
    setAddState(bot.id, { phase: 'adding', conversationId });
    try {
      await api(`/conversations/${conversationId}/members`, {
        method: 'POST',
        body: { userIds: [bot.botUserId] },
      });
      setAddState(bot.id, { phase: 'added', title: title ?? 'the group' });
    } catch (err) {
      setAddState(bot.id, {
        phase: 'error',
        message: err instanceof Error ? err.message : 'Could not add the bot.',
      });
    }
  };

  const startAdd = (bot: DirectoryBot) => {
    if (props.conversationId) {
      const conv = state.conversations.get(props.conversationId);
      void addTo(bot, props.conversationId, conv?.title ?? null);
    } else {
      setAddState(bot.id, { phase: 'picking' });
    }
  };

  return (
    <div className="bd-backdrop" onClick={props.onClose}>
      <div className="bd-sheet" role="dialog" aria-label="Bot directory" onClick={(e) => e.stopPropagation()}>
        <div className="bd-head">
          <div className="bd-title">
            <BotIcon name="bot" size={20} />
            Bots
          </div>
          <button className="bd-close" aria-label="Close" onClick={props.onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="bd-sub">Public bots anyone can add to a group they manage.</div>

        <div className="bd-scroll">
          {bots === null && !loadError && <div className="bd-state">Loading…</div>}
          {loadError && (
            <div className="bd-state">
              The directory did not load.
              <div>
                <button className="btn-accent" onClick={() => setAttempt((n) => n + 1)}>
                  Retry
                </button>
              </div>
            </div>
          )}
          {bots !== null && bots.length === 0 && (
            <div className="bd-state">No public bots yet. Build one in the developer portal.</div>
          )}

          {(bots ?? []).map((bot) => {
            const add = addStates[bot.id] ?? { phase: 'idle' };
            return (
              <div key={bot.id} className="bd-row">
                <div className="bd-row-main">
                  <Avatar kind="person" name={bot.name} url={bot.user.avatarUrl} size={40} />
                  <div className="bd-row-text">
                    <div className="bd-row-name">
                      {bot.name}
                      <span className="bd-bot-badge">Bot</span>
                      {bot.commandCount > 0 && (
                        <span className="bd-cmd-chip" title="Slash commands">
                          <BotIcon name="slash" size={11} />
                          {bot.commandCount === 1 ? '1 command' : `${bot.commandCount} commands`}
                        </span>
                      )}
                    </div>
                    {bot.user.username && <div className="bd-row-handle">@{bot.user.username}</div>}
                    {bot.description && <div className="bd-row-desc">{bot.description}</div>}
                  </div>
                  {add.phase === 'added' ? (
                    <span className="bd-added">
                      <Icon name="check" size={15} />
                      Added to {add.title}
                    </span>
                  ) : (
                    <button
                      className="bd-add-btn"
                      disabled={add.phase === 'adding'}
                      onClick={() => startAdd(bot)}
                    >
                      <Icon name="plus" size={15} />
                      {add.phase === 'adding' ? 'Adding…' : 'Add to group'}
                    </button>
                  )}
                </div>

                {add.phase === 'picking' && (
                  <div className="bd-picker">
                    {groups.length === 0 && (
                      <div className="bd-picker-empty">You are not in any groups yet.</div>
                    )}
                    {groups.map((g) => (
                      <button
                        key={g.id}
                        className="bd-picker-row"
                        onClick={() => void addTo(bot, g.id, g.title)}
                      >
                        <Avatar kind="place" name={g.title} url={g.avatarUrl} size={26} />
                        <span className="bd-picker-title">{g.title ?? 'Untitled group'}</span>
                        <span className="bd-picker-count">
                          {g.memberCount === 1 ? '1 member' : `${g.memberCount} members`}
                        </span>
                      </button>
                    ))}
                    <button
                      className="bd-picker-cancel"
                      onClick={() => setAddState(bot.id, { phase: 'idle' })}
                    >
                      Cancel
                    </button>
                  </div>
                )}

                {add.phase === 'error' && <div className="bd-row-error">{add.message}</div>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
