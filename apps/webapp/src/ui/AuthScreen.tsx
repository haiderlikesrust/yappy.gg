import { useState } from 'react';
import { ApiError, register, signIn } from '../lib/api';

export function AuthScreen(props: { onSignedIn: () => void }) {
  const [mode, setMode] = useState<'signin' | 'register'>('signin');
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
