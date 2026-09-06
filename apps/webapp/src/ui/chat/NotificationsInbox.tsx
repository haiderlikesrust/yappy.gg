import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../lib/api';
import type { Conversation } from '../../lib/types';
import { supportUrl } from '../../lib/support';
import { mentionFeed, noticeFeed, rememberNotificationsRead, type NoticePage } from '../../state/notificationFeed';
import {
  mutate,
  refreshNotificationCount,
  selectConversation,
  syncUrl,
  useStore,
} from '../../state/store';
import { Avatar } from '../Avatar';
import { BadgeMark } from '../badges';
import { Icon } from '../icons';
import { useDialogFocus } from '../useDialogFocus';
import { jumpToMessage } from './jump';
import {
  inboxRows,
  inboxTime,
  mentionWhere,
  noticeCopy,
  noticeText,
  type MentionEntry,
  type NotificationEntry,
} from './notificationModel';
import './inbox.css';

const ProfilePopover = lazy(() =>
  import('../profile/ProfilePopover').then((m) => ({ default: m.ProfilePopover })),
);
const mergeNotices = (old: NotificationEntry[], fresh: NotificationEntry[]) => [
  ...new Map([...old, ...fresh].map((entry) => [entry.id, entry])).values(),
];

export function NotificationsInbox({ onClose }: { onClose: () => void }) {
  const { state } = useStore('notifications', 'conversations');
  const mentionRevision = [...state.conversations.values()]
    .map((c) => `${c.id}:${c.self?.mentionCount ?? 0}`)
    .join(',');
  const root = useDialogFocus();
  const [notices, setNotices] = useState<NotificationEntry[] | null>(() => noticeFeed.read()?.notifications ?? null);
  const [mentions, setMentions] = useState<MentionEntry[] | null>(() => mentionFeed.read()?.mentions ?? null);
  const lastMentionRevision = useRef(mentionRevision);
  const [noticeError, setNoticeError] = useState(false);
  const [mentionError, setMentionError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reading, setReading] = useState(false);
  const [opening, setOpening] = useState(false);
  const [filter, setFilter] = useState('All');
  const [detail, setDetail] = useState<NotificationEntry | null>(null);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [selectiveRead, setSelectiveRead] = useState(false);
  const acknowledged = useRef(new Set<string>());
  const initialized = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    const ids = (notices ?? [])
      .filter((n) => !n.readAt && !acknowledged.current.has(n.id))
      .map((n) => n.id);
    // Older APIs mark the entire inbox read. Use the explicit button there;
    // selective acknowledgement keeps events arriving mid-request unread.
    if (!selectiveRead || !ids.length || filter === 'Mentions' || detail || profileId) return;
    ids.forEach((id) => acknowledged.current.add(id));
    void Promise.all(
      Array.from({ length: Math.ceil(ids.length / 100) }, (_, i) =>
        api('/social/notifications/read', {
          method: 'POST',
          body: { ids: ids.slice(i * 100, (i + 1) * 100) },
        }),
      ),
    )
      .then(() => {
        rememberNotificationsRead(new Set(ids));
        return refreshNotificationCount();
      })
      .catch(() => {
        ids.forEach((id) => acknowledged.current.delete(id));
        if (alive.current)
          setError('Couldn’t update read status. You can try “Mark updates read”.');
      });
  }, [notices, selectiveRead, filter, detail, profileId]);

  useEffect(() => {
    let cancelled = false;
    setNoticeError(false);
    void noticeFeed.load(true)
      .then((page) => {
        if (cancelled) return;
        setNotices((old) => mergeNotices(old ?? [], page.notifications));
        setSelectiveRead(page.supportsSelectiveRead === true);
        if (!initialized.current) {
          setCursor(page.nextCursor);
          initialized.current = true;
        }
      })
      .catch(() => {
        if (!cancelled) setNoticeError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [state.notificationRevision, retry]);

  useEffect(() => {
    let cancelled = false;
    setMentionError(false);
    if (lastMentionRevision.current !== mentionRevision) {
      lastMentionRevision.current = mentionRevision;
      mentionFeed.invalidate();
    }
    void mentionFeed.load(true)
      .then((page) => {
        if (!cancelled) setMentions(page.mentions);
      })
      .catch(() => {
        if (!cancelled) setMentionError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [retry, mentionRevision]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (profileId) setProfileId(null);
      else if (detail) setDetail(null);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [detail, profileId, onClose]);

  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await api<NoticePage>(
        `/social/notifications?limit=40&cursor=${encodeURIComponent(cursor)}`,
      );
      if (!alive.current) return;
      setNotices((old) => mergeNotices(old ?? [], page.notifications));
      setCursor(page.nextCursor);
    } catch {
      if (alive.current) setError('Couldn’t load older updates. Try again.');
    } finally {
      if (alive.current) setLoadingMore(false);
    }
  };
  const markRead = async () => {
    if (reading) return;
    const ids = new Set(notices?.map((n) => n.id));
    setReading(true);
    setError(null);
    try {
      await api('/social/notifications/read', { method: 'POST' });
      rememberNotificationsRead(ids);
      if (!alive.current) return;
      setNotices(
        (old) =>
          old?.map((n) =>
            ids.has(n.id) ? { ...n, readAt: n.readAt ?? new Date().toISOString() } : n,
          ) ?? null,
      );
      await refreshNotificationCount();
    } catch {
      if (alive.current) setError('Couldn’t update read status. Please try again.');
    } finally {
      if (alive.current) setReading(false);
    }
  };
  const openConversation = async (id: string, seq?: number) => {
    if (opening) return;
    setOpening(true);
    setError(null);
    try {
      // Notification targets can be older than the loaded conversation list.
      // Resolve membership and metadata before navigating to a stale target.
      const { conversation } = await api<{ conversation: Conversation }>(`/conversations/${id}`);
      if (!alive.current) return;
      mutate((s) => {
        s.conversations.set(id, conversation);
      }, 'conversations');
      await selectConversation(id);
      if (!alive.current) return;
      mutate((s) => {
        s.view = 'chats';
      }, 'ui');
      syncUrl();
      if (seq !== undefined) await jumpToMessage(id, seq);
      onClose();
    } catch {
      setError('This conversation is no longer available to you.');
    } finally {
      if (alive.current) setOpening(false);
    }
  };
  const openNotice = (entry: NotificationEntry) => {
    if (noticeCopy(entry).system || !entry.targetId) {
      setDetail(entry);
      return;
    }
    if (entry.targetType === 'conversation') void openConversation(entry.targetId);
    else if (entry.targetType === 'user') {
      setProfileId(entry.targetId);
    } else setDetail(entry);
  };
  const rows = inboxRows(notices ?? [], mentions ?? []).filter(
    (row) =>
      filter === 'All' || (filter === 'Updates' ? row.type === 'notice' : row.type === 'mention'),
  );
  const loading =
    (filter !== 'Mentions' && notices === null && !noticeError) ||
    (filter !== 'Updates' && mentions === null && !mentionError);
  const failed = (filter !== 'Mentions' && noticeError) || (filter !== 'Updates' && mentionError);

  return createPortal(
    <div className="inbox-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="inbox-card notification-inbox"
        role="dialog"
        aria-modal="true"
        aria-label="Notifications"
        ref={root}
        tabIndex={-1}
      >
        <header className="inbox-head">
          {detail ? (
            <button
              className="notice-back"
              aria-label="Back to notifications"
              onClick={() => setDetail(null)}
            >
              <Icon name="chevron-left" size={20} />
            </button>
          ) : (
            <Icon name="bell" size={20} />
          )}
          <span>Notifications</span>
          <button className="inbox-close" onClick={onClose} aria-label="Close notifications">
            <Icon name="close" size={20} />
          </button>
        </header>
        {detail ? (
          <NoticeDetails entry={detail} />
        ) : (
          <>
            <div className="notification-toolbar">
              <div className="chat-filters" role="group" aria-label="Filter notifications">
                {['All', 'Updates', 'Mentions'].map((tab) => (
                  <button key={tab} aria-pressed={filter === tab} onClick={() => setFilter(tab)}>
                    {tab}
                  </button>
                ))}
              </div>
              <button
                className="notice-read"
                disabled={reading || notices === null || !notices.some((n) => !n.readAt)}
                onClick={() => void markRead()}
              >
                {reading ? 'Saving…' : 'Mark updates read'}
              </button>
            </div>
            {(noticeError || mentionError) && (
              <div className="notification-error" role="status">
                {noticeError && mentionError
                  ? 'Couldn’t load notifications.'
                  : noticeError
                    ? 'Updates couldn’t load. Your mentions are still available.'
                    : 'Mentions couldn’t load. Your updates are still available.'}{' '}
                <button onClick={() => setRetry((n) => n + 1)}>Retry</button>
              </div>
            )}
            {error && (
              <div className="notification-error" role="alert">
                {error}
              </div>
            )}
            <div className="inbox-list">
              {loading && rows.length === 0 && (
                <div className="inbox-empty" role="status">
                  Loading notifications…
                </div>
              )}
              {!loading && !failed && rows.length === 0 && (
                <div className="inbox-empty">
                  <Icon name={filter === 'Mentions' ? 'at' : 'bell'} size={28} />
                  <p>{filter === 'Mentions' ? 'No mentions yet.' : 'You’re all caught up.'}</p>
                  <span>Mentions, account updates, and news about your groups appear here.</span>
                </div>
              )}
              {rows.map((row) =>
                row.type === 'notice' ? (
                  <NoticeRow
                    key={`n:${row.entry.id}`}
                    entry={row.entry}
                    disabled={opening}
                    onOpen={() => openNotice(row.entry)}
                  />
                ) : (
                  <button
                    key={`m:${row.entry.message?.id ?? row.entry.conversation.id}`}
                    className={`inbox-row${row.entry.unread ? ' unread' : ''}`}
                    disabled={opening || !row.entry.message}
                    onClick={() =>
                      void openConversation(row.entry.conversation.id, row.entry.message?.seq)
                    }
                  >
                    <Avatar
                      kind="person"
                      name={
                        row.entry.message?.sender?.displayName ??
                        row.entry.message?.sender?.username
                      }
                      url={row.entry.message?.sender?.avatarUrl}
                      size={38}
                    />
                    <span className="inbox-row-main">
                      <span className="inbox-row-top">
                        <span className="inbox-where">{mentionWhere(row.entry)}</span>
                        <span className="inbox-when">
                          {row.entry.message && inboxTime(row.entry.message.createdAt)}
                        </span>
                      </span>
                      <span className="inbox-preview">
                        <strong className="inbox-author">
                          {row.entry.message?.sender?.displayName ??
                            row.entry.message?.sender?.username ??
                            'Someone'}
                        </strong>
                        {row.entry.message?.content || 'Sent an attachment'}
                      </span>
                      {row.entry.isBroadcast && <span className="inbox-tag">Group mention</span>}
                    </span>
                  </button>
                ),
              )}
              {cursor && filter !== 'Mentions' && (
                <button
                  className="notice-more"
                  disabled={loadingMore}
                  onClick={() => void loadMore()}
                >
                  {loadingMore ? 'Loading…' : 'Load older updates'}
                </button>
              )}
            </div>
          </>
        )}
        <Suspense fallback={null}>
          {profileId && (
            <ProfilePopover
              userId={profileId}
              onClose={() => setProfileId(null)}
              onNavigate={onClose}
            />
          )}
        </Suspense>
      </div>
    </div>,
    document.body,
  );
}

function NoticeRow({
  entry,
  onOpen,
  disabled,
}: {
  entry: NotificationEntry;
  onOpen: () => void;
  disabled: boolean;
}) {
  const copy = noticeCopy(entry);
  const badge = noticeText(entry, 'badge') || 'verified';
  return (
    <button
      className={`inbox-row${!entry.readAt ? ' unread' : ''}`}
      onClick={onOpen}
      disabled={disabled}
    >
      <span className="notice-avatar">
        {copy.system ? (
          <span className={`notice-icon${copy.danger ? ' danger' : ''}`}>
            <Icon name={copy.icon} size={21} />
          </span>
        ) : (
          <Avatar
            kind={copy.place ? 'place' : 'person'}
            name={
              copy.place
                ? noticeText(entry, 'title')
                : (entry.actor?.displayName ?? entry.actor?.username)
            }
            url={copy.place ? noticeText(entry, 'avatarUrl') : entry.actor?.avatarUrl}
            size={38}
          />
        )}
        {entry.kind === 'group_verified' && ['verified', 'partner'].includes(badge) && (
          <span className="notice-seal">
            <BadgeMark badge={badge} size={18} />
          </span>
        )}
      </span>
      <span className="inbox-row-main">
        <span className="inbox-row-top">
          <span className="inbox-where">{copy.title}</span>
          <time
            className="inbox-when"
            dateTime={entry.createdAt}
            title={new Date(entry.createdAt).toLocaleString()}
          >
            {inboxTime(entry.createdAt)}
          </time>
        </span>
        <span className="inbox-preview">{copy.body}</span>
      </span>
    </button>
  );
}

function NoticeDetails({ entry }: { entry: NotificationEntry }) {
  const copy = noticeCopy(entry);
  const until = noticeText(entry, 'until');
  const deadline = until ? new Date(until) : null;
  const validDate = deadline && Number.isFinite(deadline.getTime()) ? deadline : null;
  let detail = noticeText(entry, 'detail');
  if (validDate && detail?.startsWith('Suspended until '))
    detail = detail.split('\n\n').slice(1).join('\n\n');
  return (
    <div className="notice-details">
      <span className={`notice-icon large${copy.danger ? ' danger' : ''}`}>
        <Icon name={copy.icon} size={26} />
      </span>
      <h2>{copy.title}</h2>
      <div className="notice-explanation">
        {entry.kind === 'account_suspended' && <span className="notice-label">Reason</span>}
        <p>{copy.body}</p>
      </div>
      {validDate && (
        <div className="notice-deadline">
          <span className="notice-label">
            {validDate.getTime() > Date.now() ? 'Scheduled to end' : 'Ended'}
          </span>
          <time dateTime={validDate.toISOString()}>
            {validDate.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
          </time>
        </div>
      )}
      {detail && <p className="notice-detail-text">{detail}</p>}
      {entry.kind === 'account_suspended' && (
        <a
          className="btn-accent notice-support"
          href={supportUrl(true, noticeText(entry, 'supportUrl'))}
          target="_blank"
          rel="noopener noreferrer"
        >
          Appeal suspension
          <Icon name="arrow-right" size={17} />
        </a>
      )}
    </div>
  );
}
