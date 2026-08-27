import { useEffect, useRef, useState } from 'react';
import { api, auth, signOut } from '../../lib/api';
import { CLIENT_VERSION } from '../../lib/config';
import { devModeEnabled, setDevMode } from '../../lib/devmode';
import { DevConsole } from '../dev/DevConsole';
import { requestTour } from '../tour/Tour';
import { notificationsEnabled, requestNotificationPermission } from '../../lib/notify';
import type { Self } from '../../lib/types';
import { gateway, mutate, useStore } from '../../state/store';
import { Avatar } from '../Avatar';
import { Icon } from '../icons';
import { AffiliationCard } from './AffiliationCard';
import { BlockedCard } from './BlockedCard';
import { ExtraIcon } from './extraIcons';
import { PeopleCard } from './PeopleCard';
import { uploadProfileMedia } from './uploadProfileMedia';
import { WhatsNewSheet } from './WhatsNewSheet';
import './settings.css';

/**
 * Settings: the profile card, edit profile + flair, presence, notifications,
 * What's New, and the way out. Mirrors the Android/iOS settings screens,
 * translated to a desk.
 */

// ─── Wire shapes beyond the client's core Self ───────────────────────────────
// `toSelf` on the server returns far more than lib/types' Self; these are the
// extra fields this screen reads. Kept local — the shared types file only
// carries what the whole app renders.

interface NotificationPrefs {
  calls?: boolean;
  reactions?: boolean;
  showPreview?: boolean;
  announcements?: boolean;
  inApp?: boolean;
  inAppSound?: boolean;
}

interface SelfSettings extends Self {
  bannerUrl?: string | null;
  flair?: { gradient?: string[] } | null;
  presence?: { status: string; customStatus: string | null };
  notifications?: NotificationPrefs;
}

type PresenceStatus = 'online' | 'idle' | 'dnd' | 'invisible';

/**
 * Flair presets — the same six the phones offer (ios ProfileSheets.swift).
 * A fixed palette rather than a colour wheel: every option is one the design
 * language already speaks.
 */
const FLAIR_PRESETS: ReadonlyArray<readonly [string, string]> = [
  ['#8B7CFF', '#00CEC9'],
  ['#FF9F43', '#FF6B81'],
  ['#00CEC9', '#6BCB77'],
  ['#FCCE09', '#FF9F43'],
  ['#FF6B81', '#8B7CFF'],
  ['#4FC3F7', '#8B7CFF'],
];

const PRESENCE_OPTIONS: Array<{ status: PresenceStatus; label: string; color: string }> = [
  { status: 'online', label: 'Online', color: 'var(--green)' },
  { status: 'idle', label: 'Idle', color: '#f5a524' },
  { status: 'dnd', label: 'Do not disturb', color: 'var(--danger)' },
  { status: 'invisible', label: 'Invisible', color: 'var(--text-3)' },
];

const NOTIFICATION_ROWS: Array<{ key: keyof NotificationPrefs; label: string; hint: string }> = [
  { key: 'announcements', label: 'Announcements', hint: 'Useful-but-not-urgent notes from @yapper. Security notices ignore this.' },
  { key: 'reactions', label: 'Reactions', hint: 'When someone reacts to your message.' },
  { key: 'calls', label: 'Calls', hint: 'Ring when someone calls you.' },
  { key: 'showPreview', label: 'Show message previews', hint: 'Message text in notifications, not just the sender.' },
  { key: 'inApp', label: 'In-app banners', hint: 'Banners for other conversations while yappy is open.' },
  { key: 'inAppSound', label: 'In-app sounds', hint: 'The little pop when a banner arrives.' },
];

const gradientCss = (stops: readonly string[]): string =>
  `linear-gradient(135deg, ${stops[0] ?? 'var(--accent)'}, ${stops[1] ?? 'var(--accent-soft)'})`;

const sameGradient = (a: readonly string[] | undefined, b: readonly string[]): boolean =>
  !!a && a.length === 2 && a[0]?.toLowerCase() === b[0]?.toLowerCase() && a[1]?.toLowerCase() === b[1]?.toLowerCase();

function adoptSelf(user: SelfSettings): void {
  mutate((s) => {
    s.me = user;
  });
  auth.setUser(user);
}

export function SettingsScreen() {
  const { state } = useStore();
  const me = state.me as SelfSettings | null;

  const [whatsNewOpen, setWhatsNewOpen] = useState(false);
  const [devMode, setDevModeState] = useState(devModeEnabled);
  const [signOutOpen, setSignOutOpen] = useState(false);

  if (!me) return <div className="chat-empty">Loading you…</div>;

  const flairStops = me.flair?.gradient;

  return (
    <div className="stg-wrap">
      <h1 className="stg-title">You</h1>

      <ProfileMediaCard me={me} flairStops={flairStops} />

      <EditProfileCard me={me} />
      <PresenceCard me={me} />
      <NotificationsCard me={me} />
      <AffiliationCard />
      <PeopleCard />
      <BlockedCard />

      {/* ── What's New ── */}
      <div className="stg-card">
        <button className="stg-nav-row" onClick={() => setWhatsNewOpen(true)}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Icon name="gift" size={17} />
            What's New
          </span>
          <span className="stg-nav-chevron">
            <Icon name="chevron-right" size={16} />
          </span>
        </button>
        <button className="stg-nav-row" onClick={requestTour}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Icon name="compass" size={17} />
            Replay the tour
          </span>
          <span className="stg-nav-chevron">
            <Icon name="chevron-right" size={16} />
          </span>
        </button>
      </div>

      {/* ── Developer ── */}
      <div className="stg-card">
        <div className="stg-card-h">Developer</div>
        <div className="stg-toggle-row">
          <div>
            <div className="stg-toggle-name">Developer mode</div>
            <div className="stg-toggle-hint">
              Build and manage bots from here, and unlock debugging tools around the app.
            </div>
          </div>
          <button
            className={`stg-switch${devMode ? ' on' : ''}`}
            role="switch"
            aria-checked={devMode}
            aria-label="Developer mode"
            onClick={() => {
              const next = !devMode;
              setDevModeState(next);
              setDevMode(next);
            }}
          />
        </div>
      </div>
      {devMode && <DevConsole />}

      {/* ── Account ── */}
      <div className="stg-card">
        <div className="stg-card-h">Account</div>
        <button className="stg-nav-row stg-danger-row" onClick={() => setSignOutOpen(true)}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Icon name="logout" size={17} />
            Sign out
          </span>
        </button>
        <div className="stg-version">yappy web {CLIENT_VERSION}</div>
      </div>

      {whatsNewOpen && <WhatsNewSheet onClose={() => setWhatsNewOpen(false)} />}
      {signOutOpen && <SignOutConfirm onClose={() => setSignOutOpen(false)} />}
    </div>
  );
}

// ─── Profile card: identity plus avatar/banner upload ────────────────────────

/**
 * The header card, now clickable: the avatar and the banner strip are both
 * file pickers. A pick runs the media pipeline with the matching purpose
 * (`avatar` / `banner` land in the public bucket — see routes/media.ts), then
 * PATCH /users/me adopts the confirmed id and the response becomes the new
 * self everywhere.
 */
function ProfileMediaCard(props: { me: SelfSettings; flairStops: readonly string[] | undefined }) {
  const { me, flairStops } = props;
  const avatarInput = useRef<HTMLInputElement>(null);
  const bannerInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<'avatar' | 'banner' | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const upload = async (purpose: 'avatar' | 'banner', file: File | undefined) => {
    if (!file || uploading) return;
    setUploading(purpose);
    setProgress(0);
    setError(null);
    try {
      const mediaId = await uploadProfileMedia(file, purpose, setProgress);
      const res = await api<{ user: SelfSettings }>('/users/me', {
        method: 'PATCH',
        body: purpose === 'avatar' ? { avatarMediaId: mediaId } : { bannerMediaId: mediaId },
      });
      adoptSelf(res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That upload did not finish. Try again.');
    } finally {
      setUploading(null);
    }
  };

  const bannerBackground = flairStops && flairStops.length === 2 ? gradientCss(flairStops) : undefined;

  return (
    <div className="stg-card stg-me-card">
      <button
        className="stg-me-banner"
        style={bannerBackground ? { background: bannerBackground } : undefined}
        title="Change banner"
        aria-label="Change banner"
        disabled={uploading !== null}
        onClick={() => bannerInput.current?.click()}
      >
        {me.bannerUrl && <img src={me.bannerUrl} alt="" />}
        <span className="stg-media-hint">
          <ExtraIcon name="camera" size={14} />
          {uploading === 'banner' ? `${Math.round(progress * 100)}%` : 'Banner'}
        </span>
      </button>
      <div className="stg-me stg-me-row">
        <button
          className="stg-me-avatar"
          title="Change avatar"
          aria-label="Change avatar"
          disabled={uploading !== null}
          onClick={() => avatarInput.current?.click()}
        >
          <Avatar kind="person" name={me.displayName ?? me.username} url={me.avatarUrl} size={64} />
          <span className="stg-avatar-overlay">
            {uploading === 'avatar' ? (
              <span className="stg-avatar-progress">{Math.round(progress * 100)}%</span>
            ) : (
              <ExtraIcon name="camera" size={17} />
            )}
          </span>
        </button>
        <div>
          <div className="stg-me-name">{me.displayName ?? me.username ?? 'You'}</div>
          {me.username && <div className="stg-me-sub">@{me.username}</div>}
          {me.email && <div className="stg-me-email">{me.email}</div>}
        </div>
      </div>
      {error && <div className="stg-error stg-media-error">{error}</div>}
      <input
        ref={avatarInput}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        hidden
        onChange={(e) => {
          void upload('avatar', e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      <input
        ref={bannerInput}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        hidden
        onChange={(e) => {
          void upload('banner', e.target.files?.[0]);
          e.target.value = '';
        }}
      />
    </div>
  );
}

// ─── Edit profile ────────────────────────────────────────────────────────────

function EditProfileCard(props: { me: SelfSettings }) {
  const { me } = props;
  const [displayName, setDisplayName] = useState(me.displayName ?? '');
  const [bio, setBio] = useState(me.bio ?? '');
  const [pronouns, setPronouns] = useState(me.pronouns ?? '');
  const [flair, setFlair] = useState<readonly [string, string] | null>(() => {
    const g = me.flair?.gradient;
    return g && g.length === 2 ? [g[0]!, g[1]!] : null;
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const res = await api<{ user: SelfSettings }>('/users/me', {
        method: 'PATCH',
        body: {
          ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
          bio: bio.trim() || null,
          pronouns: pronouns.trim() || null,
          // The flair endpoint: two hex stops on PATCH /users/me, null to
          // return to the derived per-id colour.
          flair: flair ? { gradient: [flair[0], flair[1]] } : null,
        },
      });
      adoptSelf(res.user);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not save. Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="stg-card">
      <div className="stg-card-h">Edit profile</div>

      <div className="stg-field">
        <label className="stg-label" htmlFor="stg-display-name">
          Display name
        </label>
        <input
          id="stg-display-name"
          value={displayName}
          maxLength={64}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="How you appear everywhere"
        />
      </div>

      <div className="stg-field">
        <label className="stg-label" htmlFor="stg-bio">
          Bio
        </label>
        <textarea
          id="stg-bio"
          value={bio}
          maxLength={300}
          onChange={(e) => setBio(e.target.value)}
          placeholder="A line about you"
        />
      </div>

      <div className="stg-field" style={{ maxWidth: 260 }}>
        <label className="stg-label" htmlFor="stg-pronouns">
          Pronouns
        </label>
        <input
          id="stg-pronouns"
          value={pronouns}
          maxLength={32}
          onChange={(e) => setPronouns(e.target.value)}
          placeholder="they/them"
        />
      </div>

      <div className="stg-field">
        <span className="stg-label">Flair — a colour your profile wears</span>
        <div
          className={`stg-flair-preview${flair ? '' : ' none'}`}
          style={flair ? { background: gradientCss(flair) } : undefined}
        >
          {flair ? displayName.trim() || me.username || 'you' : 'No flair — yappy picks a colour for you'}
        </div>
        <div className="stg-flair-row">
          <button
            className={`stg-flair-swatch clear${flair ? '' : ' selected'}`}
            title="No flair"
            onClick={() => setFlair(null)}
          >
            <Icon name="close" size={15} />
          </button>
          {FLAIR_PRESETS.map((preset) => (
            <button
              key={preset.join()}
              className={`stg-flair-swatch${sameGradient(flair ?? undefined, preset) ? ' selected' : ''}`}
              style={{ background: gradientCss(preset) }}
              title={`${preset[0]} to ${preset[1]}`}
              onClick={() => setFlair(preset)}
            />
          ))}
        </div>
      </div>

      <div className="stg-save-line">
        <button className="btn-accent" disabled={saving || !displayName.trim()} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save profile'}
        </button>
        {saved && <span className="stg-saved">Saved</span>}
        {error && <span className="stg-error">{error}</span>}
      </div>
    </div>
  );
}

// ─── Presence ────────────────────────────────────────────────────────────────

function PresenceCard(props: { me: SelfSettings }) {
  const initialStatus = (props.me.presence?.status ?? 'online') as PresenceStatus;
  const [status, setStatus] = useState<PresenceStatus>(
    PRESENCE_OPTIONS.some((o) => o.status === initialStatus) ? initialStatus : 'online',
  );
  const [custom, setCustom] = useState(props.me.presence?.customStatus ?? '');
  const [applied, setApplied] = useState(false);

  const apply = (nextStatus: PresenceStatus, nextCustom: string) => {
    gateway.setPresence(nextStatus, nextCustom.trim() || null);
    setApplied(true);
    setTimeout(() => setApplied(false), 2000);
  };

  return (
    <div className="stg-card">
      <div className="stg-card-h">Presence</div>
      <div className="stg-presence-row">
        {PRESENCE_OPTIONS.map((opt) => (
          <button
            key={opt.status}
            className={`stg-presence-pill${status === opt.status ? ' selected' : ''}`}
            onClick={() => {
              setStatus(opt.status);
              apply(opt.status, custom);
            }}
          >
            <span className="stg-presence-dot" style={{ background: opt.color }} />
            {opt.label}
          </button>
        ))}
      </div>
      <div className="stg-custom-status">
        <input
          value={custom}
          maxLength={128}
          placeholder="Say what you are up to"
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') apply(status, custom);
          }}
        />
        <button className="btn-accent" onClick={() => apply(status, custom)}>
          Set
        </button>
      </div>
      {applied && (
        <div className="stg-saved" style={{ marginTop: 8 }}>
          Presence updated
        </div>
      )}
    </div>
  );
}

// ─── Notifications ───────────────────────────────────────────────────────────

function NotificationsCard(props: { me: SelfSettings }) {
  const [prefs, setPrefs] = useState<NotificationPrefs>(props.me.notifications ?? {});
  const [busyKey, setBusyKey] = useState<keyof NotificationPrefs | null>(null);

  // Another device may change these mid-session; adopt what the store learns.
  useEffect(() => {
    if (props.me.notifications) setPrefs(props.me.notifications);
  }, [props.me.notifications]);

  const toggle = async (key: keyof NotificationPrefs) => {
    const next = !(prefs[key] ?? true);
    setPrefs((p) => ({ ...p, [key]: next }));
    setBusyKey(key);
    try {
      const res = await api<{ user: SelfSettings }>('/users/me/settings', {
        method: 'PATCH',
        body: { notifications: { [key]: next } },
      });
      adoptSelf(res.user);
      if (res.user.notifications) setPrefs(res.user.notifications);
    } catch {
      // The server did not take it; put the switch back where it was.
      setPrefs((p) => ({ ...p, [key]: !next }));
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div className="stg-card">
      <div className="stg-card-h">Notifications</div>
      <DesktopNotificationsRow />
      {NOTIFICATION_ROWS.map((row) => {
        const on = prefs[row.key] ?? true;
        return (
          <div key={row.key} className="stg-toggle-row">
            <div>
              <div className="stg-toggle-name">{row.label}</div>
              <div className="stg-toggle-hint">{row.hint}</div>
            </div>
            <button
              className={`stg-switch${on ? ' on' : ''}`}
              role="switch"
              aria-checked={on}
              aria-label={row.label}
              disabled={busyKey === row.key}
              onClick={() => void toggle(row.key)}
            />
          </div>
        );
      })}
    </div>
  );
}

/**
 * The browser-level permission, which the server prefs above sit on top of.
 * Granted is one-way from here — a site cannot un-request a permission — so
 * the "on" state points at the browser's own controls, and a denial is shown
 * for what it is rather than as a switch that does not stay put.
 */
function DesktopNotificationsRow() {
  const [enabled, setEnabled] = useState(notificationsEnabled());
  const [busy, setBusy] = useState(false);

  const unsupported = typeof Notification === 'undefined';
  const denied = !unsupported && Notification.permission === 'denied';

  const enable = async () => {
    setBusy(true);
    try {
      setEnabled(await requestNotificationPermission());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stg-toggle-row">
      <div>
        <div className="stg-toggle-name">Desktop notifications</div>
        <div className="stg-toggle-hint">
          {unsupported
            ? 'This browser does not support them.'
            : denied
              ? 'Blocked by the browser — allow notifications for yappy in your browser settings.'
              : enabled
                ? 'On. Turn off for this site in your browser settings.'
                : 'Pop a system notification for messages while yappy is in the background.'}
        </div>
      </div>
      <button
        className={`stg-switch${enabled ? ' on' : ''}`}
        role="switch"
        aria-checked={enabled}
        aria-label="Desktop notifications"
        disabled={unsupported || denied || enabled || busy}
        onClick={() => void enable()}
      />
    </div>
  );
}

// ─── Sign out ────────────────────────────────────────────────────────────────

function SignOutConfirm(props: { onClose: () => void }) {
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props]);

  return (
    <div className="stg-overlay" onClick={props.onClose}>
      <div className="stg-modal" role="dialog" aria-label="Sign out" onClick={(e) => e.stopPropagation()}>
        <div className="stg-modal-h">Sign out?</div>
        <div className="stg-modal-sub">Your messages stay. You can sign back in any time.</div>
        <div className="stg-modal-actions">
          <button
            className="btn-danger-ghost"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void signOut().finally(() => props.onClose());
            }}
          >
            {busy ? 'Signing out…' : 'Sign out'}
          </button>
          <button className="btn-accent" onClick={props.onClose}>
            Stay signed in
          </button>
        </div>
      </div>
    </div>
  );
}
