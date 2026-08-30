import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { Conversation, Message, PublicUser } from '../../lib/types';
import { Avatar } from '../Avatar';
import { Icon } from '../icons';
import { ThreadPanel } from '../chat/ThreadPanel';
import './forum.css';

/**
 * A forum channel: the top level is a list of posts, not a timeline.
 *
 * Underneath it is the thread machinery the app already had — a post is a
 * root message with a title, and opening one is opening its thread. So this
 * file is a list and a composer; ThreadPanel does the actual conversation.
 */

interface Post {
  id: string;
  title: string | null;
  excerpt: string;
  createdAt: string | null;
  lastActivityAt: string | null;
  replyCount: number;
  pinned: boolean;
  author: PublicUser | null;
}

/** "3m", "5h", "2d" — a forum row wants an age, not a clock reading. */
function age(iso: string | null): string {
  if (!iso) return '';
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86_400) return `${Math.floor(secs / 3600)}h`;
  if (secs < 2_592_000) return `${Math.floor(secs / 86_400)}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function ForumView(props: { conversation: Conversation; mayPost: boolean }) {
  const { conversation, mayPost } = props;
  const [posts, setPosts] = useState<Post[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Message | null>(null);
  const [composing, setComposing] = useState(false);

  const load = useCallback(
    async (after?: string | null) => {
      setError(null);
      try {
        const res = await api<{ posts: Post[]; nextCursor: string | null }>(
          `/conversations/${conversation.id}/posts${after ? `?cursor=${encodeURIComponent(after)}` : ''}`,
        );
        setPosts((prev) => (after ? [...prev, ...res.posts] : res.posts));
        setCursor(res.nextCursor);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not load posts');
      } finally {
        setLoading(false);
      }
    },
    [conversation.id],
  );

  useEffect(() => {
    setPosts([]);
    setLoading(true);
    void load();
  }, [load]);

  // Opening a post needs the full message, not the list row: ThreadPanel
  // renders a real root, with its reactions and attachments.
  async function openPost(id: string) {
    try {
      const res = await api<{ message: Message }>(
        `/conversations/${conversation.id}/messages/${id}`,
      );
      setOpen(res.message);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open that post');
    }
  }

  if (open) {
    return (
      <ThreadPanel
        conversationId={conversation.id}
        root={open}
        fullWidth
        onClose={() => {
          setOpen(null);
          // Reply counts and ordering both move while a thread is open.
          void load();
        }}
      />
    );
  }

  return (
    <div className="forum">
      <div className="forum-head">
        <div className="forum-title">
          <Icon name="forum" size={16} /> {conversation.title}
        </div>
        {mayPost && (
          <button className="btn-accent" onClick={() => setComposing(true)}>
            New post
          </button>
        )}
      </div>

      {error && <div className="grp-error">{error}</div>}

      <div className="forum-list">
        {loading && posts.length === 0 && <div className="forum-empty">Loading…</div>}
        {!loading && posts.length === 0 && (
          <div className="forum-empty">
            Nothing here yet. {mayPost ? 'Start the first post.' : 'Check back later.'}
          </div>
        )}
        {posts.map((p) => (
          <button key={p.id} className="forum-row" onClick={() => void openPost(p.id)}>
            <Avatar
              kind="person"
              name={p.author?.displayName ?? p.author?.username}
              url={p.author?.avatarUrl}
              size={34}
            />
            <div className="forum-row-main">
              <div className="forum-row-title">
                {p.pinned && <Icon name="pin" size={12} />}
                {p.title ?? 'Untitled'}
              </div>
              <div className="forum-row-excerpt">{p.excerpt}</div>
              <div className="forum-row-meta">
                {p.author?.displayName ?? p.author?.username ?? 'someone'} ·{' '}
                {p.replyCount === 0
                  ? 'no replies'
                  : `${p.replyCount} ${p.replyCount === 1 ? 'reply' : 'replies'}`}{' '}
                · {age(p.lastActivityAt)}
              </div>
            </div>
          </button>
        ))}
        {cursor && (
          <button className="forum-more" onClick={() => void load(cursor)}>
            Older posts
          </button>
        )}
      </div>

      {composing && (
        <NewPost
          conversationId={conversation.id}
          onClose={() => setComposing(false)}
          onPosted={() => {
            setComposing(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

function NewPost(props: { conversationId: string; onClose: () => void; onPosted: () => void }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function post() {
    setBusy(true);
    setError(null);
    try {
      await api(`/conversations/${props.conversationId}/messages`, {
        method: 'POST',
        body: {
          nonce: `forum-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          title: title.trim(),
          content: body.trim() || null,
        },
      });
      props.onPosted();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not post');
      setBusy(false);
    }
  }

  return (
    <div className="grp-overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="grp-modal" role="dialog" aria-label="New post">
        <div className="grp-modal-head">
          <div className="grp-modal-title">New post</div>
          <button className="grp-close" onClick={props.onClose} aria-label="Close">
            <Icon name="close" size={16} />
          </button>
        </div>

        {error && <div className="grp-error">{error}</div>}

        <div className="sp-modal-body">
          <input
            autoFocus
            value={title}
            placeholder="What is this about?"
            maxLength={100}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && title.trim() && void post()}
          />
          <textarea
            className="forum-body"
            value={body}
            placeholder="Say more…"
            rows={5}
            onChange={(e) => setBody(e.target.value)}
          />
          <button className="btn-accent" disabled={!title.trim() || busy} onClick={() => void post()}>
            {busy ? 'Posting…' : 'Post'}
          </button>
          <div className="grp-hint">
            The title is how people will find this later — it is the whole row in the list.
          </div>
        </div>
      </div>
    </div>  );
}
