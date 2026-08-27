/**
 * The floating action bar that appears on message hover: react, reply, edit,
 * delete, pin, copy. The emoji popover keeps the bar open while it is up.
 */

import { useEffect, useRef, useState } from 'react';
import { Icon } from '../icons';
import type { Message } from '../../lib/types';
import { deleteMessage, setPinned, toggleReaction } from './actions';
import { EMOJI_GRID, QUICK_EMOJI } from './emoji';

export function MessageActions(props: {
  conversationId: string;
  message: Message;
  isOwn: boolean;
  onReply: () => void;
  onEdit: () => void;
}) {
  const { conversationId, message, isOwn, onReply, onEdit } = props;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [gridOpen, setGridOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Click-away closes the emoji popover.
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
        setGridOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [pickerOpen]);

  const react = (emoji: string) => {
    setPickerOpen(false);
    setGridOpen(false);
    void toggleReaction(conversationId, message, emoji);
  };

  const copy = () => {
    if (message.content) void navigator.clipboard?.writeText(message.content);
  };

  const remove = () => {
    if (window.confirm('Delete this message for everyone?')) {
      void deleteMessage(conversationId, message.id).catch((err) =>
        console.error('delete failed', err),
      );
    }
  };

  const togglePin = () => {
    void setPinned(conversationId, message.id, !message.isPinned).catch((err) =>
      console.error('pin toggle failed', err),
    );
  };

  return (
    <div className={`msg-actions${pickerOpen ? ' open' : ''}`} ref={rootRef}>
      <button
        className="msg-action"
        title="Add reaction"
        onClick={() => {
          setPickerOpen((v) => !v);
          setGridOpen(false);
        }}
      >
        <Icon name="smile" size={16} />
      </button>
      <button className="msg-action" title="Reply" onClick={onReply}>
        <Icon name="reply" size={16} />
      </button>
      {isOwn && (
        <button className="msg-action" title="Edit" onClick={onEdit}>
          <Icon name="edit" size={16} />
        </button>
      )}
      <button
        className="msg-action"
        title={message.isPinned ? 'Unpin' : 'Pin'}
        onClick={togglePin}
        style={message.isPinned ? { color: 'var(--accent-soft)' } : undefined}
      >
        <Icon name="pin" size={16} />
      </button>
      {message.content && (
        <button className="msg-action" title="Copy text" onClick={copy}>
          <Icon name="copy" size={16} />
        </button>
      )}
      {isOwn && (
        <button className="msg-action danger" title="Delete" onClick={remove}>
          <Icon name="trash" size={16} />
        </button>
      )}

      {pickerOpen && (
        <div className="emoji-pop">
          <div className="emoji-quick">
            {QUICK_EMOJI.map((e) => (
              <button key={e} className="emoji-btn" onClick={() => react(e)}>
                {e}
              </button>
            ))}
            <button
              className="emoji-btn emoji-more"
              title="More emoji"
              onClick={() => setGridOpen((v) => !v)}
            >
              <Icon name="plus" size={16} />
            </button>
          </div>
          {gridOpen && (
            <div className="emoji-grid">
              {EMOJI_GRID.map((e, i) => (
                <button key={`${e}-${i}`} className="emoji-btn" onClick={() => react(e)}>
                  {e}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
