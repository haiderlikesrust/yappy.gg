import { useEffect, useRef, useState } from 'react';
import { api, auth } from '../../lib/api';
import { mutate } from '../../state/store';
import type { Self } from '../../lib/types';
import { Icon } from '../icons';
import './onboarding.css';

/**
 * First-run profile setup, for a session whose account has no username yet
 * (`needsOnboarding` on the auth payload — phone/social sign-ups land here).
 * Picks a handle with a live availability check and a display name, then
 * POST /auth/complete-profile. The shell decides *when* to show this; this
 * screen only knows how to finish and call `onDone`.
 *
 * The availability endpoint (GET /auth/username-available) is metered per IP —
 * sixty in hand, refilling every second — so one debounced check per pause in
 * typing is well inside the budget.
 */

type Availability =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available' }
  | { state: 'unavailable'; reason: string }
  | { state: 'error' };

const USERNAME_RE = /^[a-z0-9](?:[a-z0-9_.]*[a-z0-9])?$/i;

export function OnboardingScreen(props: { onDone: () => void }) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [avail, setAvail] = useState<Availability>({ state: 'idle' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  // Debounced availability check — one request per pause in typing.
  useEffect(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    const candidate = username.trim();
    if (candidate.length < 3) {
      setAvail({ state: 'idle' });
      return;
    }
    setAvail({ state: 'checking' });
    timer.current = window.setTimeout(async () => {
      try {
        const res = await api<{ available: boolean; reason?: string }>(
          `/auth/username-available?username=${encodeURIComponent(candidate)}`,
        );
        setAvail(
          res.available
            ? { state: 'available' }
            : { state: 'unavailable', reason: res.reason ?? 'Taken' },
        );
      } catch {
        setAvail({ state: 'error' });
      }
    }, 450);
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [username]);

  const canSubmit =
    username.trim().length >= 3 &&
    USERNAME_RE.test(username.trim()) &&
    displayName.trim().length > 0 &&
    avail.state !== 'unavailable' &&
    !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ user: Self }>('/auth/complete-profile', {
        method: 'POST',
        body: { username: username.trim(), displayName: displayName.trim() },
      });
      auth.setUser(res.user);
      mutate((s) => {
        s.me = res.user;
      });
      props.onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not save. Try again.');
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <h1>
          almost in<span className="tongue">.</span>
        </h1>
        <div className="auth-sub">Pick your handle and a name people see.</div>

        <div className="ob-field">
          <div className="ob-at-input">
            <span className="ob-at">@</span>
            <input
              value={username}
              maxLength={30}
              autoFocus
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="username"
              aria-label="Username"
              onChange={(e) => setUsername(e.target.value.replace(/\s/g, ''))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit();
              }}
            />
          </div>
          <div
            className={`ob-avail${
              avail.state === 'available' ? ' good' : avail.state === 'unavailable' ? ' bad' : ''
            }`}
            aria-live="polite"
          >
            {avail.state === 'checking' && 'Checking…'}
            {avail.state === 'available' && (
              <>
                <Icon name="check" size={13} /> Available
              </>
            )}
            {avail.state === 'unavailable' && avail.reason}
            {avail.state === 'error' && 'Could not check — you can still try it.'}
            {avail.state === 'idle' && 'Letters, numbers, dot and underscore. At least 3.'}
          </div>
        </div>

        <div className="ob-field">
          <input
            value={displayName}
            maxLength={64}
            placeholder="Display name"
            aria-label="Display name"
            onChange={(e) => setDisplayName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
            }}
          />
        </div>

        {error && <div className="auth-error">{error}</div>}

        <button className="btn-accent" disabled={!canSubmit} onClick={() => void submit()}>
          {busy ? 'Setting up…' : "Let's yap"}
        </button>
      </div>
    </div>
  );
}
