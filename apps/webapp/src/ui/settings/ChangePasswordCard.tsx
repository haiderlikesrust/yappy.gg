import { useState } from 'react';
import { ApiError, adoptSession, api } from '../../lib/api';
import type { AuthSession } from '../../lib/types';

/**
 * Changing a password without being thrown out for it.
 *
 * The server ends every session on a change — that is the point of changing a
 * password after a scare — and hands back a fresh one for the device that did
 * it. Adopting those tokens is the difference between "your other devices were
 * signed out" and "you were signed out", and the second is how somebody ends up
 * never changing their password again.
 */
export function ChangePasswordCard() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const canSave = !busy && current.length > 0 && next.length >= 8 && next !== current;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const session = await api<AuthSession>('/auth/change-password', {
        method: 'POST',
        body: { currentPassword: current, newPassword: next },
      });
      adoptSession(session);
      setCurrent('');
      setNext('');
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stg-card">
      <div className="stg-card-h">Password</div>
      <div className="stg-hint">
        {done
          ? 'Changed. Every other device has been signed out; this one stays as it is.'
          : 'Changing it signs out every other device. You stay signed in here.'}
      </div>

      {!done && (
        <div className="stg-lock-form">
          <input
            className="stg-input"
            type="password"
            autoComplete="current-password"
            placeholder="Current password"
            value={current}
            onChange={(e) => {
              setCurrent(e.target.value);
              setError(null);
            }}
          />
          <input
            className="stg-input"
            type="password"
            autoComplete="new-password"
            placeholder="New password (at least 8)"
            value={next}
            onChange={(e) => {
              setNext(e.target.value);
              setError(null);
            }}
          />
          <div className="stg-lock-actions">
            <button className="stg-person-btn" disabled={!canSave} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Change password'}
            </button>
          </div>
        </div>
      )}

      {error && <div className="stg-lock-error">{error}</div>}
    </div>
  );
}
