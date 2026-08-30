import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { Message } from '../../lib/types';
import { Avatar } from '../Avatar';
import { Icon } from '../icons';
import { jumpToMessage } from './jump';
import './inbox.css';

/**
 * Everywhere you were called.
 *
 * One list across every group, so "where was I pinged while I was away" is a
 * question with an answer — before this it could only be reconstructed by
 * opening each room and looking for the badge, which is exactly the work a
 * notification list exists to save.
 */

interface InboxConversation {
  id: string;
  type: string;
  title: string | null;
  parentId: string | null;
  parentTitle: string | null;
}

interface InboxEntry {
  /** False for a direct mention, true for `@everyone` or a role. */
  isBroadcast: boolean;
  conversation: InboxConversation;
  message: Message | null;
}

/** "Minecraft / #general", or just the room when there is no space above it. */
function whereLabel(c: InboxConversation): string {
  const here = c.title ?? (c.type === 'dm' ? 'Direct message' : 'Untitled');
  return c.parentTitle ? `${c.parentTitle} / ${here}` : here;
}

function timeAgo(iso: string): string {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 604_800) return `${Math.floor(seconds / 86_400)}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function MentionsInbox(props: {
  onOpen: (conversationId: string) => void;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<InboxEntry[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<{ mentions: InboxEntry[] }>('/users/me/mentions?limit=40')
      .then((res) => {
        if (!cancelled) setEntries(res.mentions);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props]);

  /*
   * Open the room, then move to the message.
   *
   * Two steps rather than one because they are two different waits: the room
   * has to be selected before its timeline exists, and `jumpToMessage` loads a
   * window around a `seq` that may be far outside whatever is on screen.
   */
  const open = (entry: InboxEntry) => {
    const seq = entry.message?.seq;
    props.onOpen(entry.conversation.id);
    props.onClose();
    if (typeof seq === 'number') void jumpToMessage(entry.conversation.id, seq);
  };

  return (
    <div className="inbox-backdrop" onClick={props.onClose}>
      <div className="inbox-card" onClick={(e) => e.stopPropagation()}>
        <div className="inbox-head">
          <Icon name="at" size={16} />
          <span>Mentions</span>
          <button className="inbox-close" onClick={props.onClose} aria-label="Close">
            <Icon name="close" size={16} />
          </button>
        </div>

        {failed && <div className="inbox-empty">Couldn&rsquo;t load your mentions.</div>}

        {!failed && entries === null && <div className="inbox-empty">Loading…</div>}

        {entries?.length === 0 && (
          <div className="inbox-empty">
            Nobody has called you yet. When somebody uses your name, a role you hold, or
            <span className="inbox-at"> @everyone</span>, it lands here.
          </div>
        )}

        {entries && entries.length > 0 && (
          <div className="inbox-list">
            {entries.map((entry) => (
              <button
                key={entry.message?.id ?? entry.conversation.id}
                className="inbox-row"
                onClick={() => open(entry)}
              >
                <Avatar
                  kind="person"
                  name={entry.message?.sender?.displayName ?? entry.message?.sender?.username}
                  url={entry.message?.sender?.avatarUrl}
                  size={34}
                />
                <div className="inbox-row-main">
                  <div className="inbox-row-top">
                    <span className="inbox-where">{whereLabel(entry.conversation)}</span>
                    {/*
                      A direct mention and a broadcast are not the same event to
                      the person receiving one — somebody used your name, or you
                      were in a room that got called. The list would flatten
                      them without this.
                    */}
                    {entry.isBroadcast && <span className="inbox-tag">group</span>}
                    {entry.message && (
                      <span className="inbox-when">{timeAgo(entry.message.createdAt)}</span>
                    )}
                  </div>
                  <div className="inbox-preview">
                    <span className="inbox-author">
                      {entry.message?.sender?.displayName ??
                        entry.message?.sender?.username ??
                        'Someone'}
                    </span>
                    {entry.message?.content?.trim() || 'sent something'}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
