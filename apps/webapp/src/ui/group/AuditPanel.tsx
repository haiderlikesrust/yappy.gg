import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { Avatar } from '../Avatar';
import { Icon } from '../icons';

/**
 * Who changed what, newest first.
 *
 * The panel is a reader over `GET /conversations/:id/audit` — the sentences
 * are composed here from `action` + `metadata`, because the server records
 * facts and the client owns phrasing. Metadata carries labels snapshotted at
 * write time, so a renamed or deleted role still reads as what it was called
 * when the thing happened.
 */

interface AuditActor {
  id: string;
  username: string | null;
  displayName: string | null;
}

interface AuditEntry {
  id: string;
  action: string;
  createdAt: string;
  actor: AuditActor | null;
  targetUser: AuditActor | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
}

function nameOf(user: AuditActor | null): string {
  return user?.displayName ?? user?.username ?? 'someone';
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** One entry, as a sentence. The actor's name is rendered separately. */
function sentence(entry: AuditEntry): string {
  const m = entry.metadata;
  const target = nameOf(entry.targetUser);
  switch (entry.action) {
    case 'role.create':
      return `created the role ${str(m.name)}`;
    case 'role.update':
      return m.was && m.was !== m.name
        ? `renamed the role ${str(m.was)} to ${str(m.name)}`
        : `updated the role ${str(m.name)}`;
    case 'role.delete':
      return `deleted the role ${str(m.name)}`;
    case 'member.roles_set': {
      const roles = Array.isArray(m.roles) ? (m.roles as string[]) : [];
      return roles.length
        ? `set ${target}'s roles to ${roles.join(', ')}`
        : `removed all of ${target}'s roles`;
    }
    case 'channel.create':
      return `created #${str(m.title)}`;
    case 'channel.delete':
      return `deleted #${str(m.title)}`;
    case 'channel.overwrite_set':
      return `changed who can use #${str(m.channel)} (${str(m.role)})`;
    case 'channel.overwrite_remove':
      return `removed a role's access to #${str(m.channel)}`;
    case 'invite.create':
      return m.role ? `created an invite that grants ${str(m.role)}` : 'created an invite';
    case 'invite.revoke':
      return 'revoked an invite';
    case 'member.role_changed':
      return `made ${target} a ${str(m.role)}`;
    case 'member.kicked':
      return `removed ${target}`;
    case 'member.banned':
      return m.reason ? `banned ${target} — ${str(m.reason)}` : `banned ${target}`;
    case 'member.unbanned':
      return `unbanned ${target}`;
    case 'member.muted':
      return `muted ${target}`;
    case 'member.unmuted':
      return `unmuted ${target}`;
    case 'conversation.update': {
      const changed = Array.isArray(m.changed) ? (m.changed as string[]) : [];
      const where = m.channel ? ` on #${str(m.channel)}` : '';
      return `changed settings${where}: ${changed.join(', ') || 'nothing'}`;
    }
    default:
      // A build older than the action that produced the row: name it rather
      // than hide it, because an audit log that omits things it does not
      // understand is an audit log with holes.
      return entry.action;
  }
}

function timeAgo(iso: string): string {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function AuditPanel(props: { conversationId: string; onClose: () => void }) {
  const { conversationId, onClose } = props;
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<{ entries: AuditEntry[]; nextCursor: string | null }>(
      `/conversations/${conversationId}/audit?limit=40`,
    )
      .then((res) => {
        if (cancelled) return;
        setEntries(res.entries);
        setCursor(res.nextCursor);
      })
      .catch(() => {
        if (!cancelled) setEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  const more = async (): Promise<void> => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await api<{ entries: AuditEntry[]; nextCursor: string | null }>(
        `/conversations/${conversationId}/audit?limit=40&before=${cursor}`,
      );
      setEntries((list) => [...(list ?? []), ...res.entries]);
      setCursor(res.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="grp-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="grp-modal gs-modal" role="dialog" aria-label="Audit log">
        <div className="grp-modal-head">
          <div className="grp-modal-title">Audit log</div>
          <button className="grp-close" onClick={onClose} aria-label="Close">
            <Icon name="close" size={16} />
          </button>
        </div>

        <div className="gs-body">
          {entries === null && <div className="grp-hint">Loading…</div>}
          {entries?.length === 0 && (
            <div className="grp-hint">
              Nothing yet. Admin actions — roles, channels, kicks, bans, invites — land here
              as they happen.
            </div>
          )}
          {entries?.map((entry) => (
            <div key={entry.id} className="audit-row">
              <Avatar
                kind="person"
                name={entry.actor?.displayName ?? entry.actor?.username}
                url={null}
                size={26}
              />
              <div className="audit-main">
                <span className="audit-actor">{nameOf(entry.actor)}</span> {sentence(entry)}
              </div>
              <span className="audit-when">{timeAgo(entry.createdAt)}</span>
            </div>
          ))}
          {cursor && (
            <button className="gs-choice" disabled={loadingMore} onClick={() => void more()}>
              {loadingMore ? 'Loading…' : 'Older'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
