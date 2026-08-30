/**
 * Bot component rows — buttons under a message.
 *
 * `onlyUserId` buttons are hidden from everyone else (a gate, not styling —
 * the server checks again on press). A `url` button is a link; everything else
 * POSTs an interaction and applies whatever rewritten message comes back.
 */

import { useState } from 'react';
import type { Message, MessageButton } from '../../lib/types';
import { pressMessageButton } from './actions';

export function MessageButtons(props: { conversationId: string; message: Message; meId: string }) {
  const { conversationId, message, meId } = props;
  const [pressing, setPressing] = useState<string | null>(null);
  const rows = message.components ?? [];

  const press = async (btn: MessageButton) => {
    if (pressing) return;
    setPressing(btn.customId);
    try {
      await pressMessageButton(conversationId, message.id, btn.customId);
    } catch (err) {
      console.error('button press failed', err);
    } finally {
      setPressing(null);
    }
  };

  const visible = rows
    .map((row) => row.components.filter((b) => !b.onlyUserId || b.onlyUserId === meId))
    .filter((row) => row.length > 0);
  if (visible.length === 0) return null;

  return (
    <div className="msg-btn-rows">
      {visible.map((row, i) => (
        <div className="msg-btn-row" key={i}>
          {row.map((btn) =>
            btn.url ? (
              <a
                key={btn.customId}
                className={`msg-btn${btn.style === 'secondary' ? ' secondary' : ''}`}
                href={btn.url}
                target="_blank"
                rel="noreferrer noopener"
              >
                {btn.label}
              </a>
            ) : (
              <button
                key={btn.customId}
                className={`msg-btn${btn.style === 'secondary' ? ' secondary' : ''}`}
                disabled={Boolean(btn.disabled) || pressing !== null}
                onClick={() => void press(btn)}
              >
                {btn.label}
              </button>
            ),
          )}
        </div>
      ))}
    </div>
  );
}
