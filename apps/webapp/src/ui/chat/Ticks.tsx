/**
 * Receipt ticks on own messages, and the seen-by sheet behind them.
 *
 * The grammar WhatsApp taught everyone: a clock while sending, one tick on
 * the server, two once anyone else's device has it, the pair in accent once
 * anyone has read it (Android parity — max cursor across other members, not
 * consensus). In a group, clicking the ticks opens who exactly has read it.
 */

import { useEffect, useRef, useState } from 'react';
import { Avatar } from '../Avatar';
import type { Message, PublicUser } from '../../lib/types';
import { ClockIcon, TicksIcon } from './icons-local';
import { readersOf, receiptStateFor } from './receipts';

function nameOf(user: PublicUser): string {
  return user.displayName ?? user.username ?? 'someone';
}

export function Ticks(props: {
  message: Message;
  conversationId: string;
  /** Groups get the seen-by sheet; a DM's ticks say everything already. */
  canOpenSeen: boolean;
}) {
  const { message, conversationId } = props;
  const [seenOpen, setSeenOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!seenOpen) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setSeenOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [seenOpen]);

  if (message.failed) return null;
  const state = receiptStateFor(message, conversationId);

  const glyph =
    state === 'pending' ? (
      <ClockIcon size={12} />
    ) : (
      <TicksIcon size={13} double={state !== 'sent'} />
    );

  const label =
    state === 'pending' ? 'Sending' : state === 'read' ? 'Read' : state === 'delivered' ? 'Delivered' : 'Sent';

  const readers = seenOpen ? readersOf(message, conversationId) : [];

  return (
    <span className="msg-ticks-wrap" ref={rootRef}>
      <button
        className={`msg-ticks${state === 'read' ? ' read' : ''}`}
        title={label}
        aria-label={label}
        disabled={!props.canOpenSeen || state === 'pending'}
        onClick={() => props.canOpenSeen && setSeenOpen((v) => !v)}
      >
        {glyph}
      </button>

      {seenOpen && (
        <div className="seen-pop">
          <div className="seen-pop-title">Seen by</div>
          {readers.length === 0 && <div className="seen-pop-empty">Nobody yet</div>}
          {readers.map((user) => (
            <div className="seen-row" key={user.id}>
              <Avatar kind="person" name={nameOf(user)} url={user.avatarUrl} size={22} />
              <span>{nameOf(user)}</span>
            </div>
          ))}
        </div>
      )}
    </span>
  );
}
