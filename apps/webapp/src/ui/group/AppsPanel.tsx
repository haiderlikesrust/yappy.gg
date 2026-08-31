import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { Conversation, PublicUser } from '../../lib/types';
import { Avatar } from '../Avatar';
import { Icon } from '../icons';
import { DEFAULT_CONVERSATION_PERMISSIONS } from '@yappy/shared';
import { PERM_GROUPS, Permission, errText, has } from './groupKit';

/**
 * What a member of the space already has in any channel it can see.
 *
 * The server refuses these in a grant, for the reason spelled out at the
 * checkbox: they add nothing, and because the grant lands on the space row
 * they would reach into every restricted channel as well.
 */
const BASELINE = DEFAULT_CONVERSATION_PERMISSIONS.channel;

/**
 * What the bots in this space are allowed to do.
 *
 *   GET    /v1/conversations/:id/apps                   → { apps }
 *   PUT    /v1/conversations/:id/apps/:applicationId    { permissions }
 *   DELETE /v1/conversations/:id/apps/:applicationId
 *
 * The endpoints shipped before this screen did, which meant the only way to
 * give a bot any authority was a curl command — and the only thing anybody
 * could do instead was promote it to moderator, which hands a support bot
 * kick and mute to do a job that needs two bits. That is exactly what the
 * grant exists to avoid, so it needed somewhere to be used from.
 *
 * Two rules the checkboxes mirror, so a save that cannot succeed is never
 * offered: you cannot grant a bit you do not hold yourself, and ADMINISTRATOR
 * is refused to applications outright — for everybody, the owner included.
 */

interface InstalledApp {
  applicationId: string;
  name: string;
  description: string | null;
  permissions: string;
  permissionNames: string[];
  installedById: string | null;
  installedAt: string;
  user: PublicUser;
}

/** MANAGE_ROLES → "Manage roles", for the one-line summary under a name. */
function pretty(name: string): string {
  const words = name.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function AppsPanel(props: {
  conversation: Conversation;
  actorPerms: bigint;
  isOwner: boolean;
  /** False when this account may look but not change anything. */
  canManage: boolean;
  onClose: () => void;
}) {
  const { conversation, actorPerms, isOwner, canManage, onClose } = props;
  const [apps, setApps] = useState<InstalledApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<InstalledApp | null>(null);
  const [perms, setPerms] = useState<bigint>(0n);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const load = async (): Promise<void> => {
    try {
      const res = await api<{ apps: InstalledApp[] }>(`/conversations/${conversation.id}/apps`);
      setApps(res.apps);
    } catch (err) {
      setError(errText(err, 'Could not load apps'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.id]);

  const open = (app: InstalledApp): void => {
    setEditing(app);
    setPerms(BigInt(app.permissions));
    setError(null);
  };

  const toggle = (bit: bigint): void =>
    setPerms((current) => ((current & bit) === bit ? current & ~bit : current | bit));

  const save = async (): Promise<void> => {
    if (!editing) return;
    setSaving(true);
    setError(null);
    try {
      await api(`/conversations/${conversation.id}/apps/${editing.applicationId}`, {
        method: 'PUT',
        body: { permissions: perms.toString(10) },
      });
      setEditing(null);
      setLoading(true);
      await load();
    } catch (err) {
      setError(errText(err, 'Could not save that'));
    } finally {
      setSaving(false);
    }
  };

  const uninstall = async (): Promise<void> => {
    if (!editing) return;
    setSaving(true);
    setError(null);
    try {
      await api(`/conversations/${conversation.id}/apps/${editing.applicationId}`, {
        method: 'DELETE',
      });
      setEditing(null);
      setLoading(true);
      await load();
    } catch (err) {
      setError(errText(err, 'Could not remove it'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grp-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="grp-modal gs-modal" role="dialog" aria-label="Apps">
        <div className="grp-modal-head">
          {editing ? (
            <button className="grp-close" onClick={() => setEditing(null)} aria-label="Back">
              <Icon name="chevron-left" size={18} />
            </button>
          ) : (
            <div />
          )}
          <div className="grp-modal-title">{editing ? editing.name : 'Apps'}</div>
          <button className="grp-close" onClick={onClose} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </div>

        {error && <div className="grp-error">{error}</div>}

        {editing === null ? (
          <div className="gs-body">
            {loading && <div className="grp-hint">Loading apps…</div>}
            {!loading && apps.length === 0 && (
              <div className="grp-hint">
                No apps here yet. Add a bot from Explore, then give it what it needs.
              </div>
            )}

            <div className="roles-list">
              {apps.map((app) => (
                <div key={app.applicationId} className="role-row">
                  <Avatar kind="person" name={app.name} url={app.user.avatarUrl} size={28} />
                  <button
                    className="role-name"
                    onClick={() => canManage && open(app)}
                    disabled={!canManage}
                  >
                    {app.name}
                    <span className="app-perm-summary">
                      {app.permissionNames.length === 0
                        ? 'reads and posts, like any member'
                        : app.permissionNames.map(pretty).join(' · ')}
                    </span>
                  </button>
                  {canManage && (
                    <button className="inv-btn" onClick={() => open(app)} aria-label="Manage">
                      <Icon name="settings" size={13} />
                    </button>
                  )}
                </div>
              ))}
            </div>

            {!loading && (
              <div className="grp-hint">
                Everyone here can see this list. What a program is allowed to do in a room you
                are in is not something to keep from you.
              </div>
            )}
          </div>
        ) : (
          <div className="gs-body">
            <div className="grp-hint">
              A bot is never promoted up the member ladder to do its job — it gets exactly these
              bits and nothing else. It can act on ordinary members, never on moderators, admins
              or the owner.
            </div>

            {PERM_GROUPS.map((group) => (
              <div key={group.label} className="gs-row gs-col">
                <div className="gs-label">{group.label}</div>
                <div className="perm-list">
                  {group.perms.map((p) => {
                    const bit = Permission[p.name];
                    const checked = (perms & bit) === bit;
                    /*
                     * The server's rules, mirrored. ADMINISTRATOR is never
                     * offered: it is every permission at once, forever, held
                     * by a credential in somebody's deployment environment,
                     * and a leaked token must not be the space. That refusal
                     * covers the owner too, which is the one place in this
                     * model where the owner does not get the last word.
                     */
                    /*
                     * Anything an ordinary member already has in an open
                     * channel is not offered. It would add nothing — a bot
                     * that is a member of the space already has it wherever
                     * the base grants it — and the grant lands on the space
                     * row, so it would reach into every restricted channel
                     * too. To let a bot into a locked room, admit it there.
                     */
                    const alreadyHas = (BASELINE & bit) === bit;
                    const grantable =
                      p.name === 'ADMINISTRATOR' || alreadyHas
                        ? false
                        : checked || isOwner || has(actorPerms, bit);
                    const note =
                      p.name === 'ADMINISTRATOR'
                        ? ' — never for an app'
                        : alreadyHas
                          ? ' — already has this in every channel it can see'
                          : '';
                    return (
                      <label key={p.name} className={`perm-item ${grantable ? '' : 'disabled'}`}>
                        <input
                          type="checkbox"
                          checked={checked && !alreadyHas}
                          disabled={!grantable}
                          onChange={() => toggle(bit)}
                        />
                        <span>
                          {p.label}
                          {note}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}

            <button className="btn-accent" disabled={saving} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button className="inv-btn danger" disabled={saving} onClick={() => void uninstall()}>
              Remove from this space
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
