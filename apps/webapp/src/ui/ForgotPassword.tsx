import { useState, type FormEvent } from 'react';
import { ApiError, forgotPassword, resetPassword } from '../lib/api';

/**
 * The way back into an account.
 *
 * Two steps on one card, because the second is useless without the first and
 * sending somebody to their inbox and back should not cost them their place in
 * the flow. The address carries across; the code is six digits they can read
 * out of a notification.
 *
 * The first step always claims success. The server will not say whether an
 * address has an account — that is a way to ask, one address at a time — so
 * this says "if that address is here, the code is on its way" and means it.
 */
export function ForgotPassword(props: { initialEmail?: string; onDone: () => void; onBack: () => void }) {
  const [step, setStep] = useState<'ask' | 'reset'>('ask');
  const [email, setEmail] = useState(props.initialEmail ?? '');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const request = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await forgotPassword(email.trim());
      setStep('reset');
    } catch (err) {
      // A rate limit is the one refusal worth showing here: it is the
      // difference between "try again" and "wait".
      setError(err instanceof ApiError ? err.message : 'Could not reach the server.');
    } finally {
      setBusy(false);
    }
  };

  const finish = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await resetPassword(email.trim(), code.trim(), password);
      props.onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={step === 'ask' ? request : finish}>
        <h1 className="brand">
          yappy<span className="tongue">.</span>
        </h1>
        <div className="auth-sub">
          {step === 'ask'
            ? 'We will send a code to your email.'
            : `Enter the code sent to ${email}, and pick a new password.`}
        </div>

        {step === 'ask' ? (
          <input
            placeholder="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
            autoFocus
          />
        ) : (
          <>
            <input
              placeholder="six-digit code"
              inputMode="numeric"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="one-time-code"
              required
              autoFocus
            />
            <input
              placeholder="new password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              required
              minLength={8}
            />
          </>
        )}

        {error && <div className="auth-error">{error}</div>}

        <button className="btn-accent" disabled={busy} type="submit">
          {busy ? '…' : step === 'ask' ? 'Send the code' : 'Set new password'}
        </button>

        {step === 'reset' && (
          <div className="auth-hint">
            The code lasts fifteen minutes. Setting a new password signs out every other device.
          </div>
        )}

        <div className="auth-switch">
          <button
            type="button"
            onClick={() => (step === 'reset' ? setStep('ask') : props.onBack())}
          >
            {step === 'reset' ? 'Use a different address' : 'Back to sign in'}
          </button>
        </div>
      </form>
    </div>
  );
}
