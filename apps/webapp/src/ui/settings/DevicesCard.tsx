import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { getState } from '../../state/store';
import { Icon, type IconName } from '../icons';

/**
 * Every device holding this account, and the button that ends one.
 *
 * `GET /devices` has answered this since the beginning and nothing on the web
 * ever asked. It is the first screen anyone checks after "did someone get into
 * my account", and until now the only honest answer was "change your password
 * and hope" — which does work (a password change revokes every session), but
 * it is a sledgehammer for a question that deserves a list.
 */

interface Device {
  id: string;
  name: string | null;
  platform: string;
  appVersion: string | null;
  osVersion: string | null;
  lastIp: string | null;
  lastActiveAt: string;
  createdAt: string;
  pushEnabled: boolean;
  isCurrent: boolean;
}

/**
 * A device that has published a cryptographic identity.
 *
 * Shown here because this is where somebody comes when they are worried, and
 * a safety number is only useful next to the thing it identifies. Nothing
 * encrypts anything yet — the fingerprint is a device saying "this is me",
 * and the point of publishing early is that it can say so about a device
 * that existed before there was anything to encrypt.
 */
interface KeyedDevice {
  deviceId: string;
  fingerprint: string;
}

const GLYPH: Record<string, IconName> = {
  ios: 'chat',
  android: 'chat',
  web: 'globe',
  desktop: 'settings',
};

function ago(iso: string): string {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 90) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function DevicesCard() {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [prints, setPrints] = useState<Record<string, string>>({});
  const [error, setError] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = async () => {
    setError(false);
    try {
      const res = await api<{ devices: Device[] }>('/devices');
      setDevices(res.devices);

      // Best effort, and second: a device with no published identity is an
      // older one, not a broken one, and the list is useful without this.
      const me = getState().me;
      if (me) {
        try {
          const keys = await api<{ devices: KeyedDevice[] }>(`/keys/user/${me.id}`);
          setPrints(Object.fromEntries(keys.devices.map((d) => [d.deviceId, d.fingerprint])));
        } catch {
          /* no identities published yet */
        }
      }
    } catch {
      setError(true);
      setDevices([]);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const revoke = async (id: string) => {
    setBusyId(id);
    try {
      await api(`/devices/${id}`, { method: 'DELETE' });
      setDevices((list) => (list ? list.filter((d) => d.id !== id) : list));
    } catch {
      /* it stays in the list, which is the truth */
    } finally {
      setBusyId(null);
    }
  };

  const others = (devices ?? []).filter((d) => !d.isCurrent);

  const revokeOthers = async () => {
    setBusyId('all');
    // One at a time and tolerant of failure: a device that refuses to go
    // should not stop the rest, and the list below reports what actually left.
    for (const device of others) {
      try {
        await api(`/devices/${device.id}`, { method: 'DELETE' });
      } catch {
        /* keep going */
      }
    }
    setBusyId(null);
    void load();
  };

  return (
    <div className="stg-card">
      <div className="stg-card-h">Where you are signed in</div>

      {devices === null && <div className="stg-people-empty">Loading…</div>}
      {error && (
        <div className="stg-people-empty">
          That list did not load.{' '}
          <button className="stg-link-btn" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}

      {(devices ?? []).map((device) => (
        <div key={device.id} className="stg-device-row">
          <div className="stg-device-glyph">
            <Icon name={GLYPH[device.platform] ?? 'chat'} size={18} />
          </div>
          <div className="stg-person-names">
            <div className="stg-person-name">
              {device.name ?? device.platform}
              {device.isCurrent && <span className="stg-chip">This device</span>}
            </div>
            <div className="stg-person-sub">
              {[
                device.platform,
                device.appVersion ? `v${device.appVersion}` : null,
                ago(device.lastActiveAt),
                device.lastIp,
              ]
                .filter(Boolean)
                .join(' · ')}
            </div>
            {prints[device.id] && (
              <div className="stg-fingerprint" title="This device's safety number">
                {prints[device.id]}
              </div>
            )}
          </div>
          {!device.isCurrent && (
            <button
              className="stg-person-btn ghost"
              disabled={busyId !== null}
              onClick={() => void revoke(device.id)}
            >
              {busyId === device.id ? '…' : 'Sign out'}
            </button>
          )}
        </div>
      ))}

      {others.length > 0 && (
        <button className="stg-person-btn danger" disabled={busyId !== null} onClick={() => void revokeOthers()}>
          {busyId === 'all' ? 'Signing out…' : `Sign out everywhere else (${others.length})`}
        </button>
      )}

      <div className="stg-hint">
        Signing a device out ends its session immediately. If one of these is not you, change your
        password too — that ends every session at once.
      </div>
    </div>
  );
}
