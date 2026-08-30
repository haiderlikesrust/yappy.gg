import { useEffect, useState } from 'react';
import { Permission } from '@yappy/shared';
import { api } from '../../lib/api';
import { Icon } from '../icons';

/**
 * Who a channel is for.
 *
 * Two settings that only mean something together. The floor
 * (`basePermissions`) applies to everybody, so lowering it closes the channel
 * to the whole space; a role overwrite then lets one role back in *here*,
 * which a space-wide role cannot do because it applies everywhere.
 *
 * The UI does not expose the bitfields. "Only these roles" is what somebody
 * actually wants, and the two bit patterns behind it — floor at nothing, allow
 * view/read/send per role — are an implementation of that sentence rather than
 * a thing to configure.
 */

interface Role {
  id: string;
  name: string;
  color: string | null;
}

interface Overwrite {
  roleId: string;
  allow: string;
  deny: string;
}

/** What "let this role in" grants: see it, read it, speak in it. */
const ACCESS =
  Permission.VIEW_CONVERSATION | Permission.READ_HISTORY | Permission.SEND_MESSAGES;

function bits(value: string | undefined): bigint {
  try {
    return BigInt(value ?? '0');
  } catch {
    return 0n;
  }
}

export function ChannelAccess(props: {
  conversationId: string;
  /** The space above it — where the roles live. */
  spaceId: string;
  /** Null means the channel has no floor of its own: open to the space. */
  basePermissions: string | null;
  onSetBase: (base: string | null) => Promise<void>;
}) {
  const { conversationId, spaceId, basePermissions, onSetBase } = props;

  const [roles, setRoles] = useState<Role[] | null>(null);
  const [overwrites, setOverwrites] = useState<Overwrite[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const gated = basePermissions !== null && bits(basePermissions) === 0n;

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      api<{ roles: Role[] }>(`/conversations/${spaceId}/roles`),
      api<{ overwrites: Overwrite[] }>(`/conversations/${conversationId}/permissions`),
    ])
      .then(([r, o]) => {
        if (cancelled) return;
        setRoles(r.roles);
        setOverwrites(o.overwrites);
      })
      .catch(() => {
        if (!cancelled) setRoles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId, spaceId]);

  const allowed = (roleId: string): boolean =>
    (bits(overwrites.find((o) => o.roleId === roleId)?.allow) & Permission.VIEW_CONVERSATION) ===
    Permission.VIEW_CONVERSATION;

  const toggleRole = async (role: Role): Promise<void> => {
    if (busy) return;
    setBusy(role.id);
    setError(null);
    try {
      if (allowed(role.id)) {
        await api(`/conversations/${conversationId}/permissions/${role.id}`, {
          method: 'DELETE',
        });
        setOverwrites((list) => list.filter((o) => o.roleId !== role.id));
      } else {
        const res = await api<{ overwrite: Overwrite }>(
          `/conversations/${conversationId}/permissions/${role.id}`,
          { method: 'PUT', body: { allow: ACCESS.toString(10) } },
        );
        setOverwrites((list) => [...list.filter((o) => o.roleId !== role.id), res.overwrite]);
      }
    } catch {
      setError('Could not save that.');
    } finally {
      setBusy(null);
    }
  };

  const setGated = async (next: boolean): Promise<void> => {
    if (busy) return;
    setBusy('gate');
    setError(null);
    try {
      // Null, not a permissive bitfield: absent means "inherit", which is what
      // an open channel actually is. Writing a floor equal to the default would
      // freeze it against any later change to the space.
      await onSetBase(next ? '0' : null);
    } catch {
      setError('Could not save that.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="gs-row gs-col">
      <div className="gs-label">
        <Icon name="shield" size={14} /> Who can see this channel
      </div>
      <div className="gs-sub">
        {gated
          ? 'Only the roles you pick below, plus admins.'
          : 'Everyone in the space, like every other channel.'}
      </div>

      <div className="gs-choices">
        <button
          className={`gs-choice ${!gated ? 'active' : ''}`}
          disabled={busy === 'gate'}
          onClick={() => void setGated(false)}
        >
          Everyone
        </button>
        <button
          className={`gs-choice ${gated ? 'active' : ''}`}
          disabled={busy === 'gate'}
          onClick={() => void setGated(true)}
        >
          Only these roles
        </button>
      </div>

      {gated && (
        <>
          {roles === null && <div className="gs-sub">Loading roles…</div>}
          {roles?.length === 0 && (
            <div className="gs-sub">
              This space has no roles yet. Make one first — a channel for nobody is a
              channel nobody can read, including you tomorrow.
            </div>
          )}
          {roles && roles.length > 0 && (
            <div className="perm-list">
              {roles.map((role) => (
                <label key={role.id} className="perm-item">
                  <input
                    type="checkbox"
                    checked={allowed(role.id)}
                    disabled={busy === role.id}
                    onChange={() => void toggleRole(role)}
                  />
                  <span style={role.color ? { color: role.color } : undefined}>{role.name}</span>
                </label>
              ))}
            </div>
          )}
        </>
      )}

      {error && <div className="gs-error">{error}</div>}
    </div>
  );
}
