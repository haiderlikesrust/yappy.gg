import { useEffect, useState } from 'react';
import { ApiError, api } from '../../lib/api';
import { getState } from '../../state/store';
import { Icon } from '../icons';

/**
 * Compare numbers with somebody, in person.
 *
 * The mechanism is old and boring and works: two people look at the same number
 * on two screens, and if the numbers match, nobody is standing in the middle.
 * The number is derived from every device each of you currently has, so adding
 * a phone changes it — which is the alarming event this exists to surface, and
 * why "verified" here expires by itself rather than lingering over a device
 * nobody checked.
 *
 * Nothing is encrypted yet. This is honest about that: the copy says the number
 * identifies devices rather than claiming it protects messages, because a badge
 * that overstates what it covers is worse than no badge.
 */

interface Device {
  deviceId: string;
  name: string | null;
  platform: string;
  fingerprint: string;
}

interface Directory {
  devices: Device[];
  safetyNumber: string;
  verified: boolean;
  changedSinceVerified: boolean;
  verifiedAt: string | null;
}

export function SafetyNumber(props: { userId: string; name: string; onClose: () => void }) {
  const [theirs, setTheirs] = useState<Directory | null>(null);
  const [mine, setMine] = useState<Directory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setError(null);
    try {
      const me = getState().me;
      const [them, us] = await Promise.all([
        api<Directory>(`/keys/user/${props.userId}`),
        me ? api<Directory>(`/keys/user/${me.id}`) : Promise.resolve(null),
      ]);
      setTheirs(them);
      setMine(us);
    } catch {
      setError('Could not read their keys.');
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.userId]);

  const verify = async () => {
    if (!theirs) return;
    setBusy(true);
    setError(null);
    try {
      await api('/keys/verify', {
        method: 'POST',
        body: { userId: props.userId, fingerprint: theirs.safetyNumber },
      });
      await load();
    } catch (err) {
      // The one refusal worth spelling out: their devices changed between the
      // screen rendering and the button being pressed, so what was on screen is
      // not what would have been marked verified.
      setError(
        err instanceof ApiError && err.code === 'stale_fingerprint'
          ? 'Their devices changed while you were looking. Compare the new number.'
          : 'That did not save.',
      );
      await load();
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    try {
      await api(`/keys/verify/${props.userId}`, { method: 'DELETE' });
      await load();
    } catch {
      setError('That did not save.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sn-overlay" onClick={props.onClose}>
      <div className="sn-panel" onClick={(e) => e.stopPropagation()}>
        <div className="sn-head">
          <span>Safety number</span>
          <button className="sn-close" onClick={props.onClose} aria-label="Close">
            <Icon name="close" size={16} />
          </button>
        </div>

        {error && <div className="sn-error">{error}</div>}

        {theirs === null ? (
          <div className="sn-empty">Loading…</div>
        ) : theirs.devices.length === 0 ? (
          <div className="sn-empty">
            {props.name} has no devices with published keys yet. Their apps publish one the next
            time they open them.
          </div>
        ) : (
          <>
            <div className="sn-lead">
              Compare this with what {props.name} sees on their screen. If the two match, you are
              looking at the same devices — nobody is in between.
            </div>

            <div className={`sn-number${theirs.verified ? ' verified' : ''}`}>
              {theirs.safetyNumber}
            </div>

            {theirs.verified && (
              <div className="sn-state ok">
                <Icon name="check" size={14} /> Verified
                {theirs.verifiedAt ? ` on ${new Date(theirs.verifiedAt).toLocaleDateString()}` : ''}
              </div>
            )}
            {theirs.changedSinceVerified && (
              <div className="sn-state warn">
                Their devices have changed since you verified. Compare again.
              </div>
            )}

            <div className="sn-actions">
              {theirs.verified ? (
                <button className="sn-btn ghost" disabled={busy} onClick={() => void clear()}>
                  Clear verification
                </button>
              ) : (
                <button className="sn-btn" disabled={busy} onClick={() => void verify()}>
                  {busy ? 'Saving…' : 'They match'}
                </button>
              )}
            </div>

            <div className="sn-devices">
              <div className="sn-devices-h">{props.name}&rsquo;s devices</div>
              {theirs.devices.map((d) => (
                <div key={d.deviceId} className="sn-device">
                  <span className="sn-device-name">{d.name ?? d.platform}</span>
                  <span className="sn-device-print">{d.fingerprint}</span>
                </div>
              ))}
            </div>

            {mine && mine.devices.length > 0 && (
              <div className="sn-devices">
                <div className="sn-devices-h">Yours</div>
                {mine.devices.map((d) => (
                  <div key={d.deviceId} className="sn-device">
                    <span className="sn-device-name">{d.name ?? d.platform}</span>
                    <span className="sn-device-print">{d.fingerprint}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="sn-foot">
              Messages are not end-to-end encrypted yet. This number identifies the devices on each
              account, which is the piece that has to exist first.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
