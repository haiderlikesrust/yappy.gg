/**
 * Poll rendering + voting.
 *
 * Votes have replace semantics server-side: clicking your existing choice in a
 * single-select retracts it (empty array), and multi-select submits the whole
 * toggled set each time. Tallies come back in the vote response and are folded
 * into the store by `votePoll`.
 */

import { useState } from 'react';
import { Icon } from '../icons';
import type { Message } from '../../lib/types';
import { closePoll, votePoll } from './actions';

export function PollCard(props: { conversationId: string; message: Message; isOwn: boolean }) {
  const { conversationId, message, isOwn } = props;
  const poll = message.poll;
  const [busy, setBusy] = useState(false);
  if (!poll) return null;

  const closed = Boolean(poll.closedAt) || (poll.closesAt ? Date.parse(poll.closesAt) < Date.now() : false);
  const myVotes = new Set(poll.myVotes ?? poll.options.filter((o) => o.me).map((o) => o.id));
  const sum = poll.options.reduce((acc, o) => acc + o.votes, 0);
  const total = poll.totalVotes ?? sum;

  const vote = async (optionId: string) => {
    if (closed || busy || message.pending) return;
    let next: string[];
    if (poll.multiSelect) {
      next = myVotes.has(optionId)
        ? [...myVotes].filter((id) => id !== optionId)
        : [...myVotes, optionId];
    } else {
      next = myVotes.has(optionId) ? [] : [optionId];
    }
    setBusy(true);
    try {
      await votePoll(conversationId, message.id, next);
    } catch (err) {
      console.error('poll vote failed', err);
    } finally {
      setBusy(false);
    }
  };

  const close = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await closePoll(conversationId, message.id);
    } catch (err) {
      console.error('poll close failed', err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="poll-card">
      <div className="poll-q">{poll.question}</div>
      {poll.options.map((opt) => {
        const pct = sum > 0 ? Math.round((opt.votes / sum) * 100) : 0;
        const mine = myVotes.has(opt.id);
        return (
          <button
            key={opt.id}
            className={`poll-opt${mine ? ' mine' : ''}`}
            onClick={() => void vote(opt.id)}
            disabled={closed || busy}
            aria-pressed={mine}
          >
            <span className="poll-bar" style={{ width: `${pct}%` }} />
            <span className="poll-opt-row">
              <span>
                {opt.text}
                {mine && <Icon name="check" size={13} style={{ marginLeft: 6, verticalAlign: -2 }} />}
              </span>
              <span className="poll-opt-pct">
                {opt.votes} · {pct}%
              </span>
            </span>
          </button>
        );
      })}
      <div className="poll-meta">
        <span>
          {total} vote{total === 1 ? '' : 's'}
          {poll.multiSelect ? ' · multiple choice' : ''}
        </span>
        {closed ? (
          <span>closed</span>
        ) : (
          isOwn && (
            <button className="poll-close-btn" onClick={() => void close()} disabled={busy}>
              <Icon name="close" size={12} /> close poll
            </button>
          )
        )}
      </div>
    </div>
  );
}
