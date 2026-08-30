import { useState } from 'react';
import { ApiError, api } from '../../lib/api';

/**
 * Proving the address on the account is yours.
 *
 * It matters for exactly one reason, and the card says it: an unverified
 * address cannot get you back in. Password reset mails a code to whatever is on
 * the account, so an address with a typo in it is an account with no way home.
 */
export function VerifyEmailCard(props: { email: string | null; verified: boolean; onVerified: () => void }) {
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!props.email) return null;

  if (props.verified) {
    return (
      <div className="stg-card">
        <div className="stg-card-h">Email</div>
        <div className="stg-toggle-row">
          <span>{props.email}</span>
          <span className="stg-chip">Verified</span>
        </div>
      </div>
    );
  }

  const request = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/auth/email/verify/request', { method: 'POST' });
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server.');
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/auth/email/verify', { method: 'POST', body: { code: code.trim() } });
      props.onVerified();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stg-card">
      <div className="stg-card-h">Email</div>
      <div className="stg-toggle-row">
        <span>{props.email}</span>
        <span className="stg-chip warn">Not verified</span>
      </div>
      <div className="stg-hint">
        Verify it while you can still sign in. Password reset sends a code to this address, so an
        unverified one is an account with no way back.
      </div>

      {!sent ? (
        <div className="stg-lock-actions">
          <button className="stg-person-btn" disabled={busy} onClick={() => void request()}>
            {busy ? 'Sending…' : 'Send me a code'}
          </button>
        </div>
      ) : (
        <div className="stg-lock-form">
          <input
            className="stg-input"
            placeholder="six-digit code"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
              setError(null);
            }}
          />
          <div className="stg-lock-actions">
            <button className="stg-person-btn" disabled={busy || !code} onClick={() => void verify()}>
              {busy ? 'Checking…' : 'Verify'}
            </button>
            <button className="stg-person-btn ghost" disabled={busy} onClick={() => void request()}>
              Send another
            </button>
          </div>
        </div>
      )}

      {error && <div className="stg-lock-error">{error}</div>}
    </div>
  );
}
