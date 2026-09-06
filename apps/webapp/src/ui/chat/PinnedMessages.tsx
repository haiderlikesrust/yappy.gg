import { useEffect, useState } from 'react';
import { fetchPins, type PinEntry } from './actions';
import { jumpToMessage } from './jump';
import { useStore } from '../../state/store';

export function PinnedMessages({
  conversationId,
  onJump,
}: {
  conversationId: string;
  onJump: () => void;
}) {
  const { state } = useStore('messages');
  const signature = (state.messages.get(conversationId) ?? [])
    .filter((m) => m.isPinned && !m.deletedAt)
    .map((m) => m.id)
    .join(',');
  const [pins, setPins] = useState<PinEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    setPins(null);
    void fetchPins(conversationId)
      .then((result) => {
        if (!cancelled) setPins(result);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId, signature, retry]);
  return (
    <div className="details-pins" aria-live="polite">
      {failed ? (
        <>
          <p>Couldn’t load pinned messages.</p>
          <button className="btn-ghost" onClick={() => setRetry((n) => n + 1)}>
            Retry
          </button>
        </>
      ) : pins === null ? (
        <p>Loading pinned messages…</p>
      ) : pins.length === 0 ? (
        <p>No pinned messages yet. Pins keep useful messages close by.</p>
      ) : (
        pins.map((pin) => (
          <button
            className="details-pin"
            key={pin.message.id}
            onClick={() => {
              onJump();
              void jumpToMessage(conversationId, pin.message.seq);
            }}
          >
            <strong>
              {pin.message.sender?.displayName ?? pin.message.sender?.username ?? 'Member'}
            </strong>
            <span>
              {pin.message.content ??
                (pin.message.poll
                  ? `Poll: ${pin.message.poll.question}`
                  : pin.message.attachments.length
                    ? 'Attachment'
                    : 'Message')}
            </span>
            <small>{new Date(pin.pinnedAt).toLocaleDateString()} · View message</small>
          </button>
        ))
      )}
    </div>
  );
}
