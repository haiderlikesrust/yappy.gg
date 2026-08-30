import { useEffect, useState } from 'react';
import { mutate, selectConversation, syncUrl } from '../../state/store';
import type { Message } from '../../lib/types';
import { Avatar } from '../Avatar';
import { Icon } from '../icons';
import { jumpToMessage } from '../chat/jump';
import { fetchSaved, toggleSaved, type SavedItem } from '../chat/saved';
import './saved.css';

/**
 * The Saved screen: every message the viewer bookmarked, newest first.
 * Clicking a row lands in the conversation on the message itself. Messages
 * from rooms the viewer left have already been filtered out by the server.
 */

function nameOf(sender: Message['sender']): string {
  return sender?.displayName ?? sender?.username ?? 'someone';
}

function previewOf(message: Message): string {
  if (message.content) return message.content;
  switch (message.type) {
    case 'image':
      return 'Photo';
    case 'video':
      return 'Video';
    case 'audio':
      return 'Voice note';
    case 'gif':
      return 'GIF';
    case 'sticker':
      return 'Sticker';
    case 'poll':
      return message.poll?.question ?? 'Poll';
    default:
      return 'Message';
  }
}

function when(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

export function SavedScreen() {
  const [items, setItems] = useState<SavedItem[] | null>(null);

  useEffect(() => {
    void fetchSaved()
      .then(setItems)
      .catch(() => setItems([]));
  }, []);

  const open = async (item: SavedItem) => {
    if (!item.message) return;
    const convId = item.conversation.id;
    mutate((s) => (s.view = 'chats'), 'ui');
    await selectConversation(convId);
    syncUrl();
    void jumpToMessage(convId, item.message.seq);
  };

  const unsave = async (item: SavedItem) => {
    if (!item.message) return;
    const id = item.message.id;
    setItems((prev) => prev?.filter((x) => x.message?.id !== id) ?? prev);
    await toggleSaved(item.conversation.id, id);
  };

  return (
    <div className="saved-screen">
      <header className="saved-head">
        <Icon name="bookmark" size={20} />
        <h1 className="brand">Saved</h1>
        <span className="saved-count">{items ? items.length : ''}</span>
      </header>

      {items === null && <div className="saved-empty">Loading your bookmarks…</div>}
      {items?.length === 0 && (
        <div className="saved-empty">
          Nothing saved yet. Hover a message and hit the bookmark — it lands here.
        </div>
      )}

      <div className="saved-list">
        {items?.map(
          (item) =>
            item.message && (
              <div
                key={item.message.id}
                className="saved-row"
                role="button"
                tabIndex={0}
                onClick={() => void open(item)}
                onKeyDown={(e) => e.key === 'Enter' && void open(item)}
              >
                <Avatar
                  kind="person"
                  name={nameOf(item.message.sender)}
                  url={item.message.sender?.avatarUrl}
                  size={36}
                />
                <div className="saved-main">
                  <div className="saved-top">
                    <span className="saved-sender">{nameOf(item.message.sender)}</span>
                    <span className="saved-in">
                      in {item.conversation.title ?? (item.conversation.type === 'dm' ? 'a DM' : 'a group')}
                    </span>
                    <span className="saved-date">{when(item.savedAt)}</span>
                  </div>
                  <div className="saved-preview">{previewOf(item.message)}</div>
                </div>
                <button
                  className="saved-remove"
                  title="Remove from saved"
                  aria-label="Remove from saved"
                  onClick={(e) => {
                    e.stopPropagation();
                    void unsave(item);
                  }}
                >
                  <Icon name="close" size={15} />
                </button>
              </div>
            ),
        )}
      </div>
    </div>
  );
}
