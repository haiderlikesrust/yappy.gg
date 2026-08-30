import { useEffect, useState } from 'react';
import {
  disableLock,
  lockDelay,
  lockEnabled,
  lockNow,
  onLockChange,
  setDelay,
  setPasscode,
  type LockDelay,
} from '../../lib/applock';

const DELAYS: ReadonlyArray<readonly [LockDelay, string]> = [
  [0, 'Immediately'],
  [60, 'After 1 minute'],
  [300, 'After 5 minutes'],
  [900, 'After 15 minutes'],
];

const MIN_LENGTH = 4;

/**
 * Set, change or lift the passcode.
 *
 * The copy is deliberately unglamorous about what a browser lock is worth: it
 * covers the window, it does not encrypt anything, and it lives on this
 * device only. A privacy control that oversells itself is worse than none,
 * because people act on what they think it does.
 */
export function AppLockCard() {
  const [enabled, setEnabled] = useState(lockEnabled());
  const [delay, setDelayState] = useState<LockDelay>(lockDelay());
  const [editing, setEditing] = useState(false);
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('');
  const [current, setCurrent] = useState('');
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(
    () =>
      onLockChange(() => {
        setEnabled(lockEnabled());
        setDelayState(lockDelay());
      }),
    [],
  );

  const reset = () => {
    setEditing(false);
    setRemoving(false);
    setFirst('');
    setSecond('');
    setCurrent('');
    setError(null);
  };

  const save = async () => {
    if (first.length < MIN_LENGTH) {
      setError(`At least ${MIN_LENGTH} characters.`);
      return;
    }
    if (first !== second) {
      setError('Those two do not match.');
      return;
    }
    setBusy(true);
    await setPasscode(first, delay);
    setBusy(false);
    reset();
  };

  const remove = async () => {
    setBusy(true);
    const ok = await disableLock(current);
    setBusy(false);
    if (!ok) {
      setError('That passcode is not right.');
      return;
    }
    reset();
  };

  return (
    <div className="stg-card">
      <div className="stg-card-h">App lock</div>
      <div className="stg-hint">
        A passcode over this window, for the moment you walk away from it. It stays on this device
        and is never sent anywhere — and it is a cover, not encryption: it stops someone picking up
        your laptop, not someone determined with your laptop.
      </div>

      {!enabled && !editing && (
        <button className="stg-person-btn" onClick={() => setEditing(true)}>
          Set a passcode
        </button>
      )}

      {editing && (
        <div className="stg-lock-form">
          <input
            className="stg-input"
            type="password"
            placeholder="New passcode"
            value={first}
            onChange={(e) => {
              setFirst(e.target.value);
              setError(null);
            }}
          />
          <input
            className="stg-input"
            type="password"
            placeholder="Again"
            value={second}
            onChange={(e) => {
              setSecond(e.target.value);
              setError(null);
            }}
          />
          <div className="stg-lock-actions">
            <button className="stg-person-btn" disabled={busy} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button className="stg-person-btn ghost" onClick={reset}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {enabled && !editing && (
        <>
          <label className="stg-toggle-row">
            <span>Lock when I leave</span>
            <select
              className="stg-select"
              value={delay}
              onChange={(e) => {
                const next = Number(e.target.value) as LockDelay;
                setDelayState(next);
                setDelay(next);
              }}
            >
              {DELAYS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          <div className="stg-lock-actions">
            <button className="stg-person-btn" onClick={() => lockNow()}>
              Lock now
            </button>
            <button className="stg-person-btn ghost" onClick={() => setEditing(true)}>
              Change passcode
            </button>
            {!removing && (
              <button className="stg-person-btn ghost" onClick={() => setRemoving(true)}>
                Turn off
              </button>
            )}
          </div>

          {removing && (
            <div className="stg-lock-form">
              <input
                className="stg-input"
                type="password"
                placeholder="Current passcode"
                value={current}
                onChange={(e) => {
                  setCurrent(e.target.value);
                  setError(null);
                }}
              />
              <div className="stg-lock-actions">
                <button className="stg-person-btn danger" disabled={busy} onClick={() => void remove()}>
                  {busy ? 'Checking…' : 'Turn off'}
                </button>
                <button className="stg-person-btn ghost" onClick={reset}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {error && <div className="stg-lock-error">{error}</div>}
    </div>
  );
}
