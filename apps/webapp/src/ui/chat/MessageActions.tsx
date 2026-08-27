/**
 * The floating action bar that appears on message hover: react, reply, reply
 * in thread, forward, edit, delete, pin, copy. The emoji and delete popovers
 * keep the bar open while they are up.
 */

import { useEffect, useRef, useState } from 'react';
import { devModeEnabled } from '../../lib/devmode';
import { Icon } from '../icons';
import type { Message } from '../../lib/types';
import { deleteMessage, setPinned, toggleReaction, translateMessage } from './actions';
import { customEmojisFor, ensureCustomEmojis } from './customEmojis';
import { EMOJI_GRID, QUICK_EMOJI } from './emoji';
import { ensureSaved, isSaved, toggleSaved } from './saved';

export function MessageActions(props: {
  conversationId: string;
  message: Message;
  isOwn: boolean;
  isDm: boolean;
  onReply: () => void;
  onEdit: () => void;
  onThread: () => void;
  onForward: () => void;
}) {
  const { conversationId, message, isOwn, onReply, onEdit } = props;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [gridOpen, setGridOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Idempotent, single-flight — so the Save label is right by first hover.
  useEffect(ensureSaved, []);

  // Click-away closes whichever popover is up.
  useEffect(() => {
    if (!pickerOpen && !deleteOpen) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
        setGridOpen(false);
        setDeleteOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [pickerOpen, deleteOpen]);

  const react = (emoji: string) => {
    setPickerOpen(false);
    setGridOpen(false);
    void toggleReaction(conversationId, message, emoji);
  };

  const copy = () => {
    if (message.content) void navigator.clipboard?.writeText(message.content);
  };

  const remove = (forEveryone: boolean) => {
    setDeleteOpen(false);
    void deleteMessage(conversationId, message.id, forEveryone).catch((err) =>
      console.error('delete failed', err),
    );
  };

  const togglePin = () => {
    void setPinned(conversationId, message.id, !message.isPinned).catch((err) =>
      console.error('pin toggle failed', err),
    );
  };

  const customs = props.isDm ? [] : customEmojisFor(conversationId);

  return (
    <div className={`msg-actions${pickerOpen || deleteOpen ? ' open' : ''}`} ref={rootRef}>
      <button
        className="msg-action"
        title="Add reaction"
        onClick={() => {
          setDeleteOpen(false);
          setPickerOpen((v) => !v);
          setGridOpen(false);
          if (!props.isDm) ensureCustomEmojis(conversationId);
        }}
      >
        <Icon name="smile" size={16} />
      </button>
      <button className="msg-action" title="Reply" onClick={onReply}>
        <Icon name="reply" size={16} />
      </button>
      <button className="msg-action" title="Reply in thread" onClick={props.onThread}>
        <Icon name="chat" size={16} />
      </button>
      <button className="msg-action" title="Forward" onClick={props.onForward}>
        <Icon name="arrow-right" size={16} />
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
      <button
        className="msg-action"
        title={isSaved(message.id) ? 'Remove from saved' : 'Save'}
        onClick={() => void toggleSaved(conversationId, message.id)}
        style={isSaved(message.id) ? { color: 'var(--accent-soft)' } : undefined}
      >
        <Icon name="bookmark" size={16} />
      </button>
      {message.content && !isOwn && (
        <button
          className="msg-action"
          title={message.translation ? 'Show original' : 'Translate'}
          onClick={() => void translateMessage(conversationId, message)}
        >
          <Icon name="globe" size={16} />
        </button>
      )}
      {message.content && (
        <button className="msg-action" title="Copy text" onClick={copy}>
          <Icon name="copy" size={16} />
        </button>
      )}
      {devModeEnabled() && (
        <button
          className="msg-action"
          title="Copy message JSON (developer mode)"
          onClick={() => void navigator.clipboard?.writeText(JSON.stringify(message, null, 2))}
        >
          <Icon name="chart" size={16} />
        </button>
      )}
      <button
        className="msg-action danger"
        title="Delete"
        onClick={() => {
          setPickerOpen(false);
          setGridOpen(false);
          setDeleteOpen((v) => !v);
        }}
      >
        <Icon name="trash" size={16} />
      </button>

      {deleteOpen && (
        <div className="del-pop">
          {isOwn && (
            <button className="del-pop-btn danger" onClick={() => remove(true)}>
              Delete for everyone
            </button>
          )}
          <button className="del-pop-btn" onClick={() => remove(false)}>
            Delete for me
          </button>
          <button className="del-pop-btn muted" onClick={() => setDeleteOpen(false)}>
            Cancel
          </button>
        </div>
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
            <>
              <div className="emoji-grid">
                {EMOJI_GRID.map((e, i) => (
                  <button key={`${e}-${i}`} className="emoji-btn" onClick={() => react(e)}>
                    {e}
                  </button>
                ))}
              </div>
              {customs.length > 0 && (
                <div className="emoji-grid emoji-grid-custom">
                  {customs.map((e) => (
                    <button
                      key={e.id}
                      className="emoji-btn"
                      title={`:${e.name}:`}
                      onClick={() => react(`:${e.name}:`)}
                    >
                      <img src={e.url} alt={`:${e.name}:`} width={24} height={24} loading="lazy" />
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
