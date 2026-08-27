import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { Conversation } from '../../lib/types';
import { Icon } from '../icons';
import { PERM_GROUPS, Permission, errText, has } from './groupKit';
import './group.css';

/**
 * Named roles — the admin tool, kept deliberately compact.
 *
 * Wire shapes (apps/api/src/routes/roles.ts):
 *   GET    /v1/conversations/:id/roles                  → { roles }
 *   POST   /v1/conversations/:id/roles                  { name, color?, permissions } → { role }
 *   PATCH  /v1/conversations/:id/roles/:roleId          same fields → { role }
 *   DELETE /v1/conversations/:id/roles/:roleId          → { deleted }
 *   PUT    /v1/conversations/:id/members/:userId/roles  { roleIds } (full set) → { roles }
 *
 * `permissions` travels as a decimal string (bit 62 is past 2^53). The server
 * refuses granting bits the actor lacks and reserves ADMINISTRATOR for the
 * owner; the checkboxes mirror both rules so a doomed save never leaves here.
 */

export interface RoleInfo {
  id: string;
  name: string;
  color: string | null;
  permissions: string;
  position: number;
  isHoisted: boolean;
  isMentionable: boolean;
}

const ROLE_COLORS = ['#8b7cff', '#ff8bd2', '#3dd68c', '#ffd84a', '#ff7b54', '#ff6369', '#00cec9'];

export function RolesPanel(props: {
  conversation: Conversation;
  actorPerms: bigint;
  isOwner: boolean;
  onClose: () => void;
}) {
  const { conversation, actorPerms, isOwner, onClose } = props;
  const [roles, setRoles] = useState<RoleInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<RoleInfo | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api<{ roles: RoleInfo[] }>(`/conversations/${conversation.id}/roles`);
        if (!cancelled) setRoles(res.roles);
      } catch (err) {
        if (!cancelled) setError(errText(err, 'Could not load roles'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversation.id]);

  const remove = async (role: RoleInfo): Promise<void> => {
    if (!window.confirm(`Delete the role "${role.name}"? Everyone holding it loses it.`)) return;
    setError(null);
    try {
      await api<{ deleted: boolean }>(`/conversations/${conversation.id}/roles/${role.id}`, {
        method: 'DELETE',
      });
      setRoles((list) => list.filter((r) => r.id !== role.id));
      if (editing !== 'new' && editing?.id === role.id) setEditing(null);
    } catch (err) {
      setError(errText(err, 'Could not delete that role'));
    }
  };

  return (
    <div className="grp-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="grp-modal gs-modal" role="dialog" aria-label="Roles">
        <div className="grp-modal-head">
          {editing !== null ? (
            <button className="grp-close" onClick={() => setEditing(null)} aria-label="Back">
              <Icon name="chevron-left" size={18} />
            </button>
          ) : (
            <div />
          )}
          <div className="grp-modal-title">
            {editing === 'new' ? 'New role' : editing ? editing.name : 'Roles'}
          </div>
          <button className="grp-close" onClick={onClose} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </div>

        {error && <div className="grp-error">{error}</div>}

        {editing === null ? (
          <div className="gs-body">
            <button className="btn-accent" onClick={() => setEditing('new')}>
              New role
            </button>
            {loading && <div className="grp-hint">Loading roles…</div>}
            {!loading && roles.length === 0 && (
              <div className="grp-hint">No roles yet. Roles grant extra permissions and a name color.</div>
            )}
            <div className="roles-list">
              {roles.map((role) => (
                <div key={role.id} className="role-row">
                  <span
                    className="role-dot"
                    style={{ background: role.color ?? 'var(--text-3)' }}
                  />
                  <button className="role-name" onClick={() => setEditing(role)}>
                    {role.name}
                  </button>
                  <button className="inv-btn" onClick={() => setEditing(role)}>
                    <Icon name="edit" size={13} />
                  </button>
                  <button className="inv-btn danger" onClick={() => void remove(role)}>
                    <Icon name="trash" size={13} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <RoleEditor
            conversationId={conversation.id}
            role={editing === 'new' ? null : editing}
            actorPerms={actorPerms}
            isOwner={isOwner}
            onSaved={(saved) => {
              setRoles((list) => {
                const idx = list.findIndex((r) => r.id === saved.id);
                if (idx === -1) return [...list, saved];
                const next = [...list];
                next[idx] = saved;
                return next;
              });
              setEditing(null);
            }}
            onError={(msg) => setError(msg)}
          />
        )}
      </div>
    </div>
  );
}

function RoleEditor(props: {
  conversationId: string;
  role: RoleInfo | null;
  actorPerms: bigint;
  isOwner: boolean;
  onSaved: (role: RoleInfo) => void;
  onError: (msg: string) => void;
}) {
  const { conversationId, role, actorPerms, isOwner, onSaved, onError } = props;
  const [name, setName] = useState(role?.name ?? '');
  const [color, setColor] = useState<string | null>(role?.color ?? null);
  const [perms, setPerms] = useState<bigint>(() => {
    try {
      return BigInt(role?.permissions ?? '0');
    } catch {
      return 0n;
    }
  });
  const [saving, setSaving] = useState(false);

  const toggle = (bit: bigint): void => {
    setPerms((p) => ((p & bit) === bit ? p & ~bit : p | bit));
  };

  const save = async (): Promise<void> => {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      const body = { name: trimmed, color, permissions: perms.toString(10) };
      const res = role
        ? await api<{ role: RoleInfo }>(`/conversations/${conversationId}/roles/${role.id}`, {
            method: 'PATCH',
            body,
          })
        : await api<{ role: RoleInfo }>(`/conversations/${conversationId}/roles`, {
            method: 'POST',
            body,
          });
      onSaved(res.role);
    } catch (err) {
      onError(errText(err, 'Could not save the role'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="gs-body">
      <div className="gs-row gs-col">
        <div className="gs-label">Name</div>
        <input
          autoFocus
          value={name}
          maxLength={40}
          placeholder="e.g. DJ, lore keeper, mod"
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className="gs-row gs-col">
        <div className="gs-label">Name color</div>
        <div className="gs-choices">
          <button
            className={`gs-choice ${color === null ? 'active' : ''}`}
            onClick={() => setColor(null)}
          >
            None
          </button>
          {ROLE_COLORS.map((c) => (
            <button
              key={c}
              className={`gs-swatch ${color === c ? 'active' : ''}`}
              style={{ background: c }}
              onClick={() => setColor(c)}
              aria-label={`Color ${c}`}
            />
          ))}
        </div>
      </div>

      {PERM_GROUPS.map((group) => (
        <div key={group.label} className="gs-row gs-col">
          <div className="gs-label">{group.label}</div>
          <div className="perm-list">
            {group.perms.map((p) => {
              const bit = Permission[p.name];
              const checked = (perms & bit) === bit;
              // Mirror the server's escalation guard: you cannot grant a bit
              // you do not hold, and ADMINISTRATOR is the owner's alone. Bits
              // the role already carries stay togglable so it can be lowered.
              const grantable =
                checked ||
                (p.name === 'ADMINISTRATOR' ? isOwner : isOwner || has(actorPerms, bit));
              return (
                <label key={p.name} className={`perm-item ${grantable ? '' : 'disabled'}`}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!grantable}
                    onChange={() => toggle(bit)}
                  />
                  <span>{p.label}</span>
                </label>
              );
            })}
          </div>
        </div>
      ))}

      <button className="btn-accent" disabled={!name.trim() || saving} onClick={() => void save()}>
        {saving ? 'Saving…' : role ? 'Save role' : 'Create role'}
      </button>
    </div>
  );
}

/**
 * The per-member assignment checklist, rendered inline under a member row.
 * PUT replaces the full set — two admins racing land on one intent, not the
 * union (see roles.ts:195).
 */
export function MemberRolesEditor(props: {
  conversationId: string;
  userId: string;
  allRoles: RoleInfo[];
  current: string[];
  onSaved: (roles: Array<{ id: string; name: string; color: string | null }>) => void;
  onError: (msg: string) => void;
}) {
  const { conversationId, userId, allRoles, current, onSaved, onError } = props;
  const [picked, setPicked] = useState<Set<string>>(() => new Set(current));
  const [saving, setSaving] = useState(false);

  const save = async (): Promise<void> => {
    if (saving) return;
    setSaving(true);
    try {
      const res = await api<{ roles: RoleInfo[] }>(
        `/conversations/${conversationId}/members/${userId}/roles`,
        { method: 'PUT', body: { roleIds: [...picked] } },
      );
      onSaved(res.roles.map((r) => ({ id: r.id, name: r.name, color: r.color })));
    } catch (err) {
      onError(errText(err, 'Could not update roles'));
    } finally {
      setSaving(false);
    }
  };

  if (allRoles.length === 0) {
    return <div className="grp-hint">No roles exist yet — create one from Roles.</div>;
  }

  return (
    <div className="member-roles-editor">
      {allRoles.map((role) => (
        <label key={role.id} className="perm-item">
          <input
            type="checkbox"
            checked={picked.has(role.id)}
            onChange={() =>
              setPicked((set) => {
                const next = new Set(set);
                if (next.has(role.id)) next.delete(role.id);
                else next.add(role.id);
                return next;
              })
            }
          />
          <span className="role-dot" style={{ background: role.color ?? 'var(--text-3)' }} />
          <span>{role.name}</span>
        </label>
      ))}
      <button className="gp-inline-save" disabled={saving} onClick={() => void save()}>
        {saving ? 'Saving…' : 'Save roles'}
      </button>
    </div>
  );
}
