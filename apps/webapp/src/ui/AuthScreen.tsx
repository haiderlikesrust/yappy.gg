import { useEffect, useRef, useState } from 'react';
import { ApiError, adoptSession, api, register, signIn } from '../lib/api';
import type { AuthSession } from '../lib/types';
import { Icon } from './icons';

/**
 * Sign in with the app: a device grant the phone approves.
 *
 * The browser shows a short code; the person messages @yapper `/login <code>`
 * from a phone that is already signed in and confirms it is them; the poll
 * below exchanges the approved grant for a real session. No password typed on
 * a shared machine, nothing to phish.
 */
function AppSignIn(props: { onSignedIn: () => void; onBack: () => void }) {
  const [code, setCode] = useState<string | null>(null);
  const [phase, setPhase] = useState<'starting' | 'waiting' | 'confirming' | 'dead'>('starting');
  const [deadReason, setDeadReason] = useState<string>('');
  const pollRef = useRef<string | null>(null);
  const stopped = useRef(false);

  useEffect(() => {
    stopped.current = false;
    const start = async () => {
      try {
        const res = await api<{ userCode: string; pollToken: string; expiresIn: number }>(
          '/auth/device/start',
          { method: 'POST', body: {} },
        );
        if (stopped.current) return;
        setCode(res.userCode);
        pollRef.current = res.pollToken;
        setPhase('waiting');
      } catch {
        setPhase('dead');
        setDeadReason('Could not reach the server. Try again.');
      }
    };
    void start();
    return () => {
      stopped.current = true;
    };
  }, []);

  useEffect(() => {
    if (phase !== 'waiting' && phase !== 'confirming') return;
    const timer = setInterval(async () => {
      const pollToken = pollRef.current;
      if (!pollToken) return;
      try {
        const res = await api<AuthSession & { status: string }>('/auth/device/poll', {
          method: 'POST',
          body: {
            pollToken,
            client: { platform: 'web', version: '0.1.0', device: 'browser' },
          },
        });
        if (stopped.current) return;
        if (res.status === 'approved' && res.accessToken) {
          adoptSession(res);
          props.onSignedIn();
        } else if (res.status === 'awaiting_confirm') {
          setPhase('confirming');
        } else if (res.status === 'expired' || res.status === 'denied' || res.status === 'consumed') {
          setPhase('dead');
          setDeadReason(
            res.status === 'denied'
              ? 'The sign-in was declined on the phone.'
              : 'That code expired. Start over.',
          );
        }
      } catch {
        /* transient poll failure — the next tick retries */
      }
    }, 2_500);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  return (
    <div className="auth-card">
      <h1 className="brand">
        yappy<span className="tongue">.</span>
      </h1>
      <div className="auth-sub">Sign in with the app on your phone.</div>

      {phase === 'starting' && <div className="auth-sub">Getting you a code…</div>}

      {(phase === 'waiting' || phase === 'confirming') && code && (
        <>
          <div className="device-code">{code}</div>
          <ol className="device-steps">
            <li>Open yappy on your phone</li>
            <li>
              Message <b>@yapper</b>: <code>/login {code}</code>
            </li>
            <li>Confirm it&apos;s you</li>
          </ol>
          <div className="device-wait">
            <span className="device-pulse" />
            {phase === 'confirming' ? 'Check your phone — yapper is asking if it’s you.' : 'Waiting for the app…'}
          </div>
        </>
      )}

      {phase === 'dead' && (
        <>
          <div className="auth-error">{deadReason}</div>
          <button className="btn-accent" onClick={props.onBack}>
            Back
          </button>
        </>
      )}

      <div className="auth-switch">
        <button type="button" onClick={props.onBack}>
          <Icon name="chevron-left" size={12} /> password instead
        </button>
      </div>
    </div>
  );
}

export function AuthScreen(props: { onSignedIn: () => void }) {
  const [mode, setMode] = useState<'signin' | 'register' | 'app'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'signin') await signIn(email.trim(), password);
      else await register(email.trim(), password, username.trim().toLowerCase());
      props.onSignedIn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server.');
    } finally {
      setBusy(false);
    }
  };

  if (mode === 'app') {
    return (
      <div className="auth-wrap">
        <AppSignIn onSignedIn={props.onSignedIn} onBack={() => setMode('signin')} />
      </div>
    );
  }

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <h1 className="brand">
          yappy<span className="tongue">.</span>
        </h1>
        <div className="auth-sub">
          {mode === 'signin' ? 'Back to the group.' : 'Make a place for your people.'}
        </div>

        {mode === 'register' && (
          <input
            placeholder="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
            minLength={3}
          />
        )}
        <input
          placeholder="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          required
        />
        <input
          placeholder="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
          required
          minLength={mode === 'register' ? 8 : 1}
        />

        {error && <div className="auth-error">{error}</div>}

        <button className="btn-accent" disabled={busy} type="submit">
          {busy ? '…' : mode === 'signin' ? 'Sign in' : 'Create account'}
        </button>

        {mode === 'signin' && (
          <button type="button" className="btn-quiet" onClick={() => setMode('app')}>
            Sign in with the app
          </button>
        )}

        <div className="auth-switch">
          {mode === 'signin' ? (
            <>
              New here?{' '}
              <button type="button" onClick={() => setMode('register')}>
                Create an account
              </button>
            </>
          ) : (
            <>
              Already have one?{' '}
              <button type="button" onClick={() => setMode('signin')}>
                Sign in
              </button>
            </>
          )}
        </div>
      </form>
    </div>
  );
}
