/**
 * Poll creation modal. Sends `type: 'poll'` with sendMessageBody's poll shape:
 * `{ question, options (2-6 strings), multiSelect, anonymous, closesAt }`.
 */

import { useEffect, useRef, useState } from 'react';
import { Icon } from '../icons';
import { sendChatMessage } from './actions';

const MAX_OPTIONS = 6;

const CLOSE_CHOICES: Array<{ label: string; seconds: number | null }> = [
  { label: 'No close time', seconds: null },
  { label: '1 hour', seconds: 3_600 },
  { label: '8 hours', seconds: 28_800 },
  { label: '24 hours', seconds: 86_400 },
  { label: '3 days', seconds: 259_200 },
];

export function PollComposer(props: { conversationId: string; onClose: () => void }) {
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState<string[]>(['', '']);
  const [multiSelect, setMultiSelect] = useState(false);
  const [anonymous, setAnonymous] = useState(false);
  const [closeIdx, setCloseIdx] = useState(0);
  const [sending, setSending] = useState(false);
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => firstRef.current?.focus(), []);

  const setOption = (i: number, value: string) =>
    setOptions((prev) => prev.map((o, j) => (j === i ? value : o)));

  const filled = options.map((o) => o.trim()).filter(Boolean);
  const canSend = question.trim().length > 0 && filled.length >= 2 && !sending;

  const submit = async () => {
    if (!canSend) return;
    setSending(true);
    const seconds = CLOSE_CHOICES[closeIdx]?.seconds ?? null;
    try {
      await sendChatMessage(props.conversationId, null, {
        type: 'poll',
        poll: {
          question: question.trim(),
          options: filled.slice(0, MAX_OPTIONS),
          multiSelect,
          anonymous,
          closesAt: seconds ? new Date(Date.now() + seconds * 1000).toISOString() : null,
        },
      });
      props.onClose();
    } catch (err) {
      console.error('poll send failed', err);
      setSending(false);
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal-card" role="dialog" aria-label="Create a poll">
        <header className="modal-head">
          <Icon name="chart" size={17} style={{ color: 'var(--accent-soft)' }} />
          <div className="modal-title">Create a poll</div>
          <button className="chat-head-btn" title="Close" aria-label="Close" onClick={props.onClose}>
            <Icon name="close" size={16} />
          </button>
        </header>

        <label className="modal-label" htmlFor="poll-q">Question</label>
        <input
          id="poll-q"
          ref={firstRef}
          className="modal-input"
          maxLength={512}
          placeholder="Ask the room something…"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
        />

        <div className="modal-label">Options</div>
        {options.map((opt, i) => (
          <div className="poll-opt-edit" key={i}>
            <input
              className="modal-input"
              maxLength={128}
              placeholder={`Option ${i + 1}`}
              value={opt}
              onChange={(e) => setOption(i, e.target.value)}
            />
            {options.length > 2 && (
              <button
                className="chat-head-btn"
                title="Remove option"
                aria-label={`Remove option ${i + 1}`}
                onClick={() => setOptions((prev) => prev.filter((_, j) => j !== i))}
              >
                <Icon name="close" size={14} />
              </button>
            )}
          </div>
        ))}
        {options.length < MAX_OPTIONS && (
          <button className="poll-add-opt" onClick={() => setOptions((prev) => [...prev, ''])}>
            <Icon name="plus" size={14} /> add option
          </button>
        )}

        <label className="modal-toggle">
          <input
            type="checkbox"
            checked={multiSelect}
            onChange={(e) => setMultiSelect(e.target.checked)}
          />
          Allow choosing several answers
        </label>
        <label className="modal-toggle">
          <input
            type="checkbox"
            checked={anonymous}
            onChange={(e) => setAnonymous(e.target.checked)}
          />
          Anonymous votes
        </label>

        <label className="modal-label" htmlFor="poll-close">Closes</label>
        <select
          id="poll-close"
          className="modal-input"
          value={closeIdx}
          onChange={(e) => setCloseIdx(Number(e.target.value))}
        >
          {CLOSE_CHOICES.map((c, i) => (
            <option key={c.label} value={i}>
              {c.label}
            </option>
          ))}
        </select>

        <div className="modal-actions">
          <button className="modal-cancel" onClick={props.onClose}>cancel</button>
          <button className="modal-primary" onClick={() => void submit()} disabled={!canSend}>
            <Icon name="send" size={14} /> {sending ? 'sending…' : 'Send poll'}
          </button>
        </div>
      </div>
    </div>
  );
}
