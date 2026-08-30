import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { Icon } from '../icons';

/**
 * Incoming webhooks for one channel.
 *
 * The URL is the whole interface, and it is shown exactly once, at creation —
 * the same discipline as bot tokens, because a retrievable credential is a
 * much better target than the systems it posts for. The list afterwards shows
 * names and last-used, never the URL.
 */

interface WebhookRow {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export function ChannelWebhooks(props: { conversationId: string }) {
  const { conversationId } = props;
  const [hooks, setHooks] = useState<WebhookRow[] | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  /** The one chance to copy it. Cleared when the panel closes with the state. */
  const [minted, setMinted] = useState<{ name: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<{ webhooks: WebhookRow[] }>(`/conversations/${conversationId}/webhooks`)
      .then((res) => {
        if (!cancelled) setHooks(res.webhooks);
      })
      .catch(() => {
        if (!cancelled) setHooks([]);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  const create = async (): Promise<void> => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ webhook: WebhookRow & { url: string } }>(
        `/conversations/${conversationId}/webhooks`,
        { method: 'POST', body: { name: trimmed } },
      );
      setHooks((list) => [res.webhook, ...(list ?? [])]);
      setMinted({ name: res.webhook.name, url: res.webhook.url });
      setName('');
      try {
        await navigator.clipboard.writeText(res.webhook.url);
        setCopied(true);
      } catch {
        /* clipboard denied — the URL is on screen to copy by hand */
      }
    } catch {
      setError('Could not create the webhook.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await api(`/conversations/${conversationId}/webhooks/${id}`, { method: 'DELETE' });
      setHooks((list) => (list ?? []).filter((h) => h.id !== id));
      if (minted) setMinted(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gs-row gs-col">
      <div className="gs-label">
        <Icon name="link" size={14} /> Webhooks
      </div>
      <div className="gs-sub">
        A URL that posts into this channel. Paste it into GitHub, Grafana, or a cron job —
        anything that can POST JSON.
      </div>

      {minted && (
        <div className="wh-minted">
          <div className="wh-minted-title">
            {minted.name} — copy this now{copied ? ' (copied)' : ''}. It will not be shown again.
          </div>
          <code className="wh-minted-url">{minted.url}</code>
        </div>
      )}

      <div className="wh-create">
        <input
          value={name}
          maxLength={64}
          placeholder="e.g. deploys, alerts"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void create();
          }}
        />
        <button className="gs-choice" disabled={!name.trim() || busy} onClick={() => void create()}>
          {busy ? '…' : 'Create'}
        </button>
      </div>

      {hooks?.map((hook) => (
        <div key={hook.id} className="wh-row">
          <span className="wh-name">{hook.name}</span>
          <span className="wh-meta">
            {hook.lastUsedAt ? `last used ${new Date(hook.lastUsedAt).toLocaleDateString()}` : 'never used'}
          </span>
          <button className="wh-remove" onClick={() => void remove(hook.id)}>
            remove
          </button>
        </div>
      ))}

      {error && <div className="gs-error">{error}</div>}
    </div>
  );
}
