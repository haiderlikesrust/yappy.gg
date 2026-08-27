import { useEffect, useState } from 'react';
import { ApiError, api } from '../../lib/api';
import type { PublicUser } from '../../lib/types';
import { Avatar } from '../Avatar';
import { Icon } from '../icons';
import { EmbedBuilder } from './EmbedBuilder';
import { EventInspector } from './EventInspector';
import './dev.css';

/**
 * The bot console: what the developer portal does, without leaving the app.
 *
 * Everything here is the /apps REST surface (apps/api/src/routes/bots.ts).
 * The two write-once secrets — the bot token and the webhook signing secret —
 * are shown exactly once, in a copy box that never comes back, mirroring the
 * server's own rule (there is no endpoint that shows them again).
 */

interface BotCommandRow {
  name: string;
  description: string;
  usage?: string;
  context: 'dm' | 'group' | 'all';
  staffOnly?: boolean;
}

interface AppView {
  id: string;
  name: string;
  description: string | null;
  isPublic: boolean;
  tokenPrefix: string;
  tokenIssuedAt: string;
  lastUsedAt: string | null;
  createdAt: string;
  commands: BotCommandRow[];
  webhookUrl: string | null;
  bot: PublicUser;
}

const COMMAND_NAME = /^[a-z][a-z0-9_-]{1,31}$/;

function errText(err: unknown): string {
  return err instanceof ApiError ? err.message : 'That did not work. Try again.';
}

function since(iso: string | null): string {
  if (!iso) return 'never';
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** A secret, shown once. */
function SecretBox(props: { label: string; value: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="dev-secret">
      <div className="dev-secret-label">
        {props.label} — shown once, copy it now
      </div>
      <code className="dev-secret-value">{props.value}</code>
      <div className="dev-secret-actions">
        <button
          className="dev-btn accent"
          onClick={() => {
            void navigator.clipboard?.writeText(props.value);
            setCopied(true);
          }}
        >
          <Icon name="copy" size={14} /> {copied ? 'Copied' : 'Copy'}
        </button>
        <button className="dev-btn" onClick={props.onDismiss}>
          I saved it
        </button>
      </div>
    </div>
  );
}

export function DevConsole() {
  const [apps, setApps] = useState<AppView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [builderOpen, setBuilderOpen] = useState(false);

  const load = async () => {
    try {
      const res = await api<{ applications: AppView[] }>('/apps');
      setApps(res.applications);
      setError(null);
    } catch (err) {
      setError(errText(err));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="stg-card dev-console">
      <div className="stg-card-h">Your bots</div>
      <p className="dev-hint">
        A bot is an account your code signs in as — it joins groups, declares slash commands, and
        hears events over a webhook or its own gateway connection. Docs live at{' '}
        <a href="https://docs.yappy.gg" target="_blank" rel="noreferrer">
          docs.yappy.gg
        </a>
        .
      </p>

      {error && <div className="dev-error">{error}</div>}
      {apps === null && !error && <div className="dev-hint">Loading…</div>}

      {apps?.map((appView) => (
        <BotCard key={appView.id} app={appView} onChanged={load} />
      ))}

      {apps?.length === 0 && !creating && (
        <div className="dev-hint">No bots yet. The first one takes a minute.</div>
      )}

      {creating ? (
        <CreateBot
          onDone={() => {
            setCreating(false);
            void load();
          }}
          onCancel={() => setCreating(false)}
        />
      ) : (
        <div className="dev-row-actions">
          <button className="dev-btn accent" onClick={() => setCreating(true)}>
            <Icon name="plus" size={14} /> New bot
          </button>
          <button className="dev-btn" onClick={() => setBuilderOpen(true)}>
            <Icon name="sparkle" size={14} /> Embed builder
          </button>
        </div>
      )}

      {builderOpen && <EmbedBuilder onClose={() => setBuilderOpen(false)} />}
    </div>
  );
}

function CreateBot(props: { onDone: () => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [description, setDescription] = useState('');
  const [isPublic, setIsPublic] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ token: string }>('/apps', {
        method: 'POST',
        body: {
          name: name.trim(),
          username: username.trim().toLowerCase(),
          description: description.trim() || null,
          isPublic,
        },
      });
      setToken(res.token);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  if (token) {
    return <SecretBox label="Bot token" value={token} onDismiss={props.onDone} />;
  }

  return (
    <div className="dev-form">
      <input placeholder="Name (how it appears in chat)" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
      <input placeholder="@username (lowercase, shared with people)" value={username} onChange={(e) => setUsername(e.target.value)} maxLength={32} />
      <input placeholder="What it does (optional)" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} />
      <label className="dev-check">
        <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />
        List in the public bot directory
      </label>
      {error && <div className="dev-error">{error}</div>}
      <div className="dev-row-actions">
        <button className="dev-btn accent" disabled={busy || !name.trim() || !username.trim()} onClick={() => void submit()}>
          Create
        </button>
        <button className="dev-btn" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function BotCard(props: { app: AppView; onChanged: () => void }) {
  const { app: bot } = props;
  const [open, setOpen] = useState<'commands' | 'webhook' | 'settings' | 'events' | null>(null);
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rotate = async () => {
    if (!window.confirm('Rotate the token? The current one stops working immediately.')) return;
    try {
      const res = await api<{ token: string }>(`/apps/${bot.id}/token`, { method: 'POST', body: {} });
      setSecret({ label: 'New bot token', value: res.token });
      props.onChanged();
    } catch (err) {
      setError(errText(err));
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete ${bot.name}? Its messages stay, the handle stays claimed, and this cannot be undone.`)) return;
    try {
      await api(`/apps/${bot.id}`, { method: 'DELETE' });
      props.onChanged();
    } catch (err) {
      setError(errText(err));
    }
  };

  return (
    <div className="dev-bot">
      <div className="dev-bot-head">
        <Avatar kind="person" name={bot.name} url={bot.bot.avatarUrl} size={38} />
        <div className="dev-bot-id">
          <div className="dev-bot-name">
            {bot.name}
            {bot.isPublic && <span className="dev-tag">public</span>}
          </div>
          <div className="dev-bot-sub">
            @{bot.bot.username} · token {bot.tokenPrefix}… · last used {since(bot.lastUsedAt)}
          </div>
        </div>
      </div>

      <div className="dev-row-actions">
        <button className="dev-btn" onClick={() => setOpen(open === 'commands' ? null : 'commands')}>
          Commands ({bot.commands.length})
        </button>
        <button className="dev-btn" onClick={() => setOpen(open === 'webhook' ? null : 'webhook')}>
          Webhook {bot.webhookUrl ? '· set' : '· off'}
        </button>
        <button className="dev-btn" onClick={() => setOpen(open === 'events' ? null : 'events')}>
          Events
        </button>
        <button className="dev-btn" onClick={() => setOpen(open === 'settings' ? null : 'settings')}>
          Settings
        </button>
        <button className="dev-btn" onClick={() => void rotate()}>
          Rotate token
        </button>
        <button className="dev-btn danger" onClick={() => void remove()}>
          Delete
        </button>
      </div>

      {error && <div className="dev-error">{error}</div>}
      {secret && (
        <SecretBox label={secret.label} value={secret.value} onDismiss={() => setSecret(null)} />
      )}

      {open === 'events' && <EventInspector applicationId={bot.id} />}
      {open === 'commands' && <CommandsEditor app={bot} onSaved={props.onChanged} />}
      {open === 'webhook' && (
        <WebhookEditor app={bot} onSaved={props.onChanged} onSecret={(s) => setSecret(s)} />
      )}
      {open === 'settings' && <BotSettings app={bot} onSaved={props.onChanged} />}
    </div>
  );
}

function BotSettings(props: { app: AppView; onSaved: () => void }) {
  const [name, setName] = useState(props.app.name);
  const [description, setDescription] = useState(props.app.description ?? '');
  const [isPublic, setIsPublic] = useState(props.app.isPublic);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/apps/${props.app.id}`, {
        method: 'PATCH',
        body: { name: name.trim(), description: description.trim() || null, isPublic },
      });
      props.onSaved();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dev-form">
      <input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
      <input value={description} placeholder="Description" onChange={(e) => setDescription(e.target.value)} maxLength={200} />
      <label className="dev-check">
        <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />
        List in the public bot directory
      </label>
      {error && <div className="dev-error">{error}</div>}
      <button className="dev-btn accent" disabled={busy || !name.trim()} onClick={() => void save()}>
        Save
      </button>
    </div>
  );
}

function CommandsEditor(props: { app: AppView; onSaved: () => void }) {
  const [rows, setRows] = useState<BotCommandRow[]>(() =>
    props.app.commands.map((c) => ({ ...c, context: c.context ?? 'all' })),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const set = (i: number, patch: Partial<BotCommandRow>) =>
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const problems = rows.flatMap((r, i) => {
    const out: string[] = [];
    if (!COMMAND_NAME.test(r.name)) out.push(`Row ${i + 1}: name must match a-z then a-z0-9_- (2–32 chars)`);
    if (!r.description.trim()) out.push(`Row ${i + 1}: description required`);
    return out;
  });
  const dupes = new Set(rows.map((r) => r.name)).size !== rows.length;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/apps/${props.app.id}/commands`, {
        method: 'PUT',
        body: {
          commands: rows.map((r) => ({
            name: r.name,
            description: r.description.trim(),
            ...(r.usage?.trim() ? { usage: r.usage.trim() } : {}),
            context: r.context,
            staffOnly: Boolean(r.staffOnly),
          })),
        },
      });
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
      props.onSaved();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dev-form">
      {rows.map((row, i) => (
        <div className="dev-cmd" key={i}>
          <input className="dev-cmd-name" placeholder="name" value={row.name} onChange={(e) => set(i, { name: e.target.value })} />
          <input className="dev-cmd-desc" placeholder="what it does" value={row.description} onChange={(e) => set(i, { description: e.target.value })} maxLength={100} />
          <input className="dev-cmd-usage" placeholder="/name example" value={row.usage ?? ''} onChange={(e) => set(i, { usage: e.target.value })} maxLength={64} />
          <select value={row.context} onChange={(e) => set(i, { context: e.target.value as BotCommandRow['context'] })}>
            <option value="all">everywhere</option>
            <option value="dm">DM only</option>
            <option value="group">groups only</option>
          </select>
          <button
            className="dev-btn danger"
            title="Remove"
            onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      ))}
      {rows.length < 50 && (
        <button
          className="dev-btn"
          onClick={() => setRows((prev) => [...prev, { name: '', description: '', context: 'all' }])}
        >
          <Icon name="plus" size={13} /> Add command
        </button>
      )}
      {(problems.length > 0 || dupes) && (
        <div className="dev-error">{dupes ? 'Two commands share a name. ' : ''}{problems[0] ?? ''}</div>
      )}
      {error && <div className="dev-error">{error}</div>}
      <button className="dev-btn accent" disabled={busy || problems.length > 0 || dupes} onClick={() => void save()}>
        {saved ? 'Saved' : 'Save commands'}
      </button>
      <div className="dev-hint">
        These power the composer's "/" autocomplete in every room the bot is in.
      </div>
    </div>
  );
}

function WebhookEditor(props: {
  app: AppView;
  onSaved: () => void;
  onSecret: (s: { label: string; value: string }) => void;
}) {
  const [url, setUrl] = useState(props.app.webhookUrl ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (nextUrl: string | null) => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ webhookUrl: string | null; secret?: string }>(
        `/apps/${props.app.id}/webhook`,
        { method: 'PUT', body: { url: nextUrl } },
      );
      if (res.secret) props.onSecret({ label: 'Webhook signing secret', value: res.secret });
      props.onSaved();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dev-form">
      <input
        placeholder="https://your-server.example/webhook (https required; localhost allowed for dev)"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
      />
      {error && <div className="dev-error">{error}</div>}
      <div className="dev-row-actions">
        <button className="dev-btn accent" disabled={busy || !url.trim()} onClick={() => void save(url.trim())}>
          Save webhook
        </button>
        {props.app.webhookUrl && (
          <button className="dev-btn danger" disabled={busy} onClick={() => void save(null)}>
            Remove
          </button>
        )}
      </div>
      <div className="dev-hint">
        Saving mints a fresh signing secret, shown once. Test delivery by messaging{' '}
        <b>@yapper</b>: <code>/webhook</code>. Bots without a webhook can connect to the gateway
        with their token instead — no public URL needed.
      </div>
    </div>
  );
}
