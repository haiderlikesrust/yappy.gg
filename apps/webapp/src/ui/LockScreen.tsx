import { useEffect, useRef, useState, type FormEvent } from 'react';
import { isLocked, onLockChange, unlock } from '../lib/applock';
import { Icon } from './icons';

/**
 * What a locked window shows.
 *
 * Rendered over everything, including the desktop titlebar, and it does not
 * unmount the app underneath — coming back should land on the same message in
 * the same chat, not on a reload. A wrong passcode counts, and the wait grows
 * with the count: not a real defence against a machine, but enough that
 * guessing by hand is a bad evening.
 */
export function LockScreen() {
  const [locked, setLocked] = useState(isLocked());
  const [value, setValue] = useState('');
  const [wrong, setWrong] = useState(false);
  const [busy, setBusy] = useState(false);
  const attempts = useRef(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => onLockChange(() => setLocked(isLocked())), []);

  useEffect(() => {
    if (locked) {
      setValue('');
      setWrong(false);
      // A passcode field nobody can type into is a bug people report as "it
      // froze", so take focus explicitly.
      setTimeout(() => input.current?.focus(), 40);
    }
  }, [locked]);

  if (!locked) return null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !value) return;
    setBusy(true);
    const ok = await unlock(value);
    if (ok) {
      attempts.current = 0;
      setValue('');
    } else {
      attempts.current += 1;
      setWrong(true);
      setValue('');
      // 0s, 0s, 1s, 2s, 3s… — deliberate, and visible in the button.
      const wait = Math.min(Math.max(attempts.current - 2, 0), 5) * 1_000;
      if (wait) await new Promise((r) => setTimeout(r, wait));
      input.current?.focus();
    }
    setBusy(false);
  };

  return (
    <div className="lock-screen" role="dialog" aria-modal="true" aria-label="yappy is locked">
      <form className="lock-card" onSubmit={(e) => void submit(e)}>
        <div className="lock-mark">
          <Icon name="lock" size={26} />
        </div>
        <div className="lock-title">yappy is locked</div>
        <div className="lock-sub">Enter your passcode to carry on.</div>
        <input
          ref={input}
          className={`lock-input${wrong ? ' wrong' : ''}`}
          type="password"
          inputMode="numeric"
          autoComplete="off"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setWrong(false);
          }}
          aria-label="Passcode"
        />
        <button className="btn-accent lock-btn" type="submit" disabled={busy || !value}>
          {busy ? 'Checking…' : 'Unlock'}
        </button>
        {wrong && <div className="lock-wrong">That is not it.</div>}
      </form>
    </div>
  );
}
