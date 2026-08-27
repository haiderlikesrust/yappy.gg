/**
 * Slim pinned-messages bar under the chat header, with a dropdown panel
 * listing the pins from GET /conversations/:id/pins.
 */

import { useEffect, useRef, useState } from 'react';
import { Icon } from '../icons';
import type { PublicUser } from '../../lib/types';
import { fetchPins, setPinned, type PinEntry } from './actions';
import { jumpToMessage } from './jump';

function nameOf(user: PublicUser | null | undefined): string {
  return user?.displayName ?? user?.username ?? 'someone';
}

export function PinnedBar(props: { conversationId: string; pinnedCount: number }) {
  const { conversationId, pinnedCount } = props;
  const [open, setOpen] = useState(false);
  const [pins, setPins] = useState<PinEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Conversation switch resets the panel.
  useEffect(() => {
    setOpen(false);
    setPins(null);
  }, [conversationId]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && pins === null && !loading) {
      setLoading(true);
      try {
        setPins(await fetchPins(conversationId));
      } catch (err) {
        console.error('pins fetch failed', err);
        setPins([]);
      } finally {
        setLoading(false);
      }
    }
  };

  const unpin = async (messageId: string) => {
    try {
      await setPinned(conversationId, messageId, false);
      setPins((prev) => prev?.filter((p) => p.message.id !== messageId) ?? prev);
    } catch (err) {
      console.error('unpin failed', err);
    }
  };

  return (
    <div className="pinned-bar" ref={rootRef}>
      <Icon name="pin" size={14} style={{ color: 'var(--accent-soft)' }} />
      <span>
        {pinnedCount} pinned message{pinnedCount === 1 ? '' : 's'}
      </span>
      <button className="pinned-bar-view" onClick={() => void toggle()}>
        view <Icon name={open ? 'chevron-left' : 'chevron-right'} size={12} />
      </button>

      {open && (
        <div className="pins-panel">
          {loading && <div className="pins-panel-empty">loading…</div>}
          {!loading && pins?.length === 0 && <div className="pins-panel-empty">Nothing pinned yet</div>}
          {pins?.map((pin) => (
            <div className="pin-item" key={pin.message.id}>
              <div className="pin-author">
                {nameOf(pin.message.sender)}
                <time>{new Date(pin.pinnedAt).toLocaleDateString()}</time>
                <button
                  className="pin-unpin"
                  title="Unpin"
                  onClick={() => void unpin(pin.message.id)}
                >
                  <Icon name="close" size={13} />
                </button>
              </div>
              <button
                className="pin-content pin-jump"
                title="Jump to message"
                onClick={() => {
                  setOpen(false);
                  void jumpToMessage(conversationId, pin.message.seq);
                }}
              >
                {pin.message.content ??
                  (pin.message.attachments.length > 0
                    ? 'attachment'
                    : pin.message.poll
                      ? `poll: ${pin.message.poll.question}`
                      : 'message')}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
