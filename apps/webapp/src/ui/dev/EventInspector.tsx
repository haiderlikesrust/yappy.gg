import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../../lib/api';
import { Icon } from '../icons';

/**
 * The event inspector: what the platform actually sent this bot's webhook,
 * attempt by attempt. The server keeps the last 50 per application; this is a
 * debugging window, not an archive, and it reads like one — status, latency,
 * and the exact payload the endpoint saw.
 */

interface EventRow {
  id: string;
  type: string;
  status: 'delivered' | 'failed' | string;
  httpStatus: number | null;
  durationMs: number | null;
  detail: string | null;
  payload: string | null;
  createdAt: string;
}

function ago(iso: string): string {
  const s = Math.floor((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(iso).toLocaleString();
}

function prettyPayload(raw: string | null): string {
  if (!raw) return '(no payload recorded)';
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw; // truncated payloads are not valid JSON — show as-is
  }
}

export function EventInspector(props: { applicationId: string }) {
  const [events, setEvents] = useState<EventRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api<{ events: EventRow[] }>(`/apps/${props.applicationId}/events`);
      setEvents(res.events);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load events.');
    }
  }, [props.applicationId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="dev-form">
      <div className="dev-events-head">
        <span className="dev-hint">Last {events?.length ?? '…'} webhook delivery attempts, newest first.</span>
        <button className="dev-btn" onClick={() => void load()}>
          Refresh
        </button>
      </div>

      {error && <div className="dev-error">{error}</div>}

      {events?.length === 0 && (
        <div className="dev-hint">
          Nothing yet. Events appear the moment a delivery is attempted — set a webhook, add the
          bot to a group, and say something. (Bots connected to the gateway receive events over
          their socket, which is not logged here.)
        </div>
      )}

      {events?.map((event) => (
        <div key={event.id} className={`dev-event${event.status === 'failed' ? ' failed' : ''}`}>
          <button
            className="dev-event-row"
            onClick={() => setOpenId(openId === event.id ? null : event.id)}
          >
            <span className={`dev-event-dot ${event.status}`} />
            <span className="dev-event-type">{event.type}</span>
            <span className="dev-event-meta">
              {event.httpStatus ? `HTTP ${event.httpStatus}` : (event.detail ?? '')}
              {event.durationMs !== null ? ` · ${event.durationMs}ms` : ''}
            </span>
            <span className="dev-event-time">{ago(event.createdAt)}</span>
          </button>
          {openId === event.id && (
            <div className="dev-event-body">
              {event.detail && event.status === 'failed' && (
                <div className="dev-error">{event.detail}</div>
              )}
              <pre>{prettyPayload(event.payload)}</pre>
              <button
                className="dev-btn"
                onClick={() => void navigator.clipboard?.writeText(prettyPayload(event.payload))}
              >
                <Icon name="copy" size={13} /> Copy payload
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
