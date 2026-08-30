import { useEffect, useState } from 'react';
import { REPORT_REASONS, REPORT_REASON_LABEL, type ReportReason } from '@yappy/shared';
import { api } from '../../lib/api';
import './profile.css';

/**
 * Report a user (or, via `targetType`, anything else the server accepts).
 * The reason enum comes from the shared package, so this picker cannot drift
 * from what POST /moderation/reports validates — the same list yapper's guided
 * flow uses, in the same order.
 */
export function ReportModal(props: {
  targetType: 'user' | 'message' | 'conversation';
  targetId: string;
  /** Shown in the header — "@handle", a message snippet, a group name. */
  targetLabel: string;
  onClose: () => void;
}) {
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [detail, setDetail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [thanks, setThanks] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props]);

  const submit = async () => {
    if (!reason) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ reportId: string; message: string }>('/moderation/reports', {
        method: 'POST',
        body: {
          targetType: props.targetType,
          targetId: props.targetId,
          reason,
          ...(detail.trim() ? { detail: detail.trim() } : {}),
        },
      });
      setThanks(res.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That report did not send. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pp-report-backdrop" onClick={props.onClose}>
      <div
        className="pp-report"
        role="dialog"
        aria-label="Report"
        onClick={(e) => e.stopPropagation()}
      >
        {thanks ? (
          <>
            <div className="pp-report-h">Report sent</div>
            <div className="pp-report-sub">{thanks}</div>
            <div className="pp-report-actions">
              <button className="btn-accent" onClick={props.onClose}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="pp-report-h">Report {props.targetLabel}</div>
            <div className="pp-report-sub">
              What is wrong? Our team sees the report, not the person you are reporting.
            </div>
            <div className="pp-report-reasons" role="radiogroup" aria-label="Reason">
              {REPORT_REASONS.map((r) => (
                <button
                  key={r}
                  role="radio"
                  aria-checked={reason === r}
                  className={`pp-report-reason${reason === r ? ' selected' : ''}`}
                  onClick={() => setReason(r)}
                >
                  {REPORT_REASON_LABEL[r]}
                </button>
              ))}
            </div>
            <textarea
              className="pp-report-detail"
              value={detail}
              maxLength={2000}
              placeholder="Anything else that helps (optional)"
              onChange={(e) => setDetail(e.target.value)}
            />
            {error && <div className="pp-report-error">{error}</div>}
            <div className="pp-report-actions">
              <button className="pp-btn ghost" onClick={props.onClose}>
                Cancel
              </button>
              <button className="btn-accent" disabled={!reason || busy} onClick={() => void submit()}>
                {busy ? 'Sending…' : 'Send report'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
