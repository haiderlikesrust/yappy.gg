import { useState } from 'react';
import { api } from '../../lib/api';
import type { Conversation } from '../../lib/types';
import { Icon } from '../icons';
import { errText } from './groupKit';
import './group.css';

/**
 * Asking for the group's badge, as a small three-step wizard (the web's
 * mirror of iOS VerificationWizard.swift).
 *
 * POST /v1/conversations/:id/verification-request (conversations.ts:1035,
 * owner/admin only) with verificationRequestBody (schemas.ts:390):
 *   purpose  12..600 chars — required, the floor is server-enforced
 *   link     optional, must be a well-formed URL ≤300 chars
 *   note     optional, ≤600 chars
 * Response is { ok: true }; one open request at a time (409 otherwise).
 */

type Step = 'purpose' | 'proof' | 'review' | 'done';

export function VerificationWizard(props: { conversation: Conversation; onClose: () => void }) {
  const { conversation, onClose } = props;
  const [step, setStep] = useState<Step>('purpose');
  const [purpose, setPurpose] = useState('');
  const [link, setLink] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const purposeOk = purpose.trim().length >= 12;
  const linkTrimmed = link.trim();
  const linkOk =
    linkTrimmed === '' ||
    (() => {
      try {
        const u = new URL(linkTrimmed);
        return u.protocol === 'http:' || u.protocol === 'https:';
      } catch {
        return false;
      }
    })();

  const submit = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api<{ ok: boolean }>(`/conversations/${conversation.id}/verification-request`, {
        method: 'POST',
        body: {
          purpose: purpose.trim(),
          ...(linkTrimmed ? { link: linkTrimmed } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
        },
      });
      setStep('done');
    } catch (err) {
      setError(errText(err, 'Could not send the request'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grp-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="grp-modal" role="dialog" aria-label="Request verification">
        <div className="grp-modal-head">
          <div className="grp-modal-title">
            <Icon name="shield" size={16} style={{ verticalAlign: '-2px' }} /> Verification
          </div>
          <button className="grp-close" onClick={onClose} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </div>

        {step !== 'done' && (
          <div className="wiz-steps">
            {(['purpose', 'proof', 'review'] as const).map((s, i) => (
              <span key={s} className={`wiz-dot ${step === s ? 'active' : ''}`}>
                {i + 1}
              </span>
            ))}
          </div>
        )}

        {error && <div className="grp-error">{error}</div>}

        {step === 'purpose' && (
          <div className="gs-body">
            <div className="gs-label">What is this group, and why should it be verified?</div>
            <textarea
              className="gs-textarea"
              autoFocus
              rows={4}
              maxLength={600}
              placeholder="Tell the review team who you are and what this place is for…"
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
            />
            <div className="inv-meta">
              {purposeOk ? `${purpose.trim().length}/600` : 'At least 12 characters'}
            </div>
            <button className="btn-accent" disabled={!purposeOk} onClick={() => setStep('proof')}>
              Continue
            </button>
          </div>
        )}

        {step === 'proof' && (
          <div className="gs-body">
            <div className="gs-label">Link (optional)</div>
            <input
              autoFocus
              value={link}
              maxLength={300}
              placeholder="https://your-community.example"
              onChange={(e) => setLink(e.target.value)}
            />
            {!linkOk && <div className="grp-error" style={{ padding: 0 }}>That does not look like a URL</div>}
            <div className="gs-label">Anything else (optional)</div>
            <textarea
              className="gs-textarea"
              rows={3}
              maxLength={600}
              placeholder="Extra context for the reviewers…"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <div className="gs-choices">
              <button className="gs-choice" onClick={() => setStep('purpose')}>
                Back
              </button>
              <button
                className="btn-accent"
                style={{ flex: 1 }}
                disabled={!linkOk}
                onClick={() => setStep('review')}
              >
                Continue
              </button>
            </div>
          </div>
        )}

        {step === 'review' && (
          <div className="gs-body">
            <div className="wiz-review">
              <div className="gs-label">Purpose</div>
              <div className="wiz-review-text">{purpose.trim()}</div>
              {linkTrimmed && (
                <>
                  <div className="gs-label">Link</div>
                  <div className="wiz-review-text">{linkTrimmed}</div>
                </>
              )}
              {note.trim() && (
                <>
                  <div className="gs-label">Note</div>
                  <div className="wiz-review-text">{note.trim()}</div>
                </>
              )}
            </div>
            <div className="gs-choices">
              <button className="gs-choice" onClick={() => setStep('proof')}>
                Back
              </button>
              <button
                className="btn-accent"
                style={{ flex: 1 }}
                disabled={busy}
                onClick={() => void submit()}
              >
                {busy ? 'Sending…' : 'Send request'}
              </button>
            </div>
          </div>
        )}

        {step === 'done' && (
          <div className="gs-body" style={{ alignItems: 'center', textAlign: 'center' }}>
            <Icon name="check" size={32} style={{ color: 'var(--green)' }} />
            <div className="gs-label">Request sent</div>
            <div className="grp-hint">
              The review team will take a look. You will hear back from @yapper.
            </div>
            <button className="btn-accent" onClick={onClose}>
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
