import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { loadConversations, mutate, selectConversation, useStore } from '../../state/store';
import { Avatar } from '../Avatar';
import { BotDirectory } from '../bots/BotDirectory';
import { Icon, type IconName } from '../icons';
import './explore.css';

/**
 * The verified seal: a check sitting in a filled circle. Local to Explore —
 * the shared set draws outline glyphs, and a badge wants to read as a stamp.
 * Same visual voice: 24px grid, 1.8 stroke, round caps.
 */
function VerifiedSeal(props: { size?: number }) {
  const size = props.size ?? 15;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className="place-seal"
    >
      <circle cx="12" cy="12" r="9.5" fill="currentColor" stroke="none" />
      <path
        d="m8 12.2 2.7 2.7L16 9.5"
        stroke="var(--bg)"
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Explore: public places, ranked by warmth.
 *
 * The web translation of the iOS screen: a place-first directory whose first
 * question is "is anyone there right now?", not "how big is it". Groups are
 * drawn as covers wearing their own flair gradient — a wall of covers says
 * "places", a list of grey rows says "database".
 */

interface DiscoverAppearance {
  accent?: string | null;
  gradient?: string[] | null;
  effect?: string | null;
  emoji?: string | null;
}

/** One row of GET /conversations/discover. */
interface DiscoverEntry {
  id: string;
  type: string;
  title: string | null;
  description: string | null;
  handle: string | null;
  memberCount: number;
  avatarUrl: string | null;
  badge: string | null;
  hereCount: number;
  live: boolean;
  createdAt: string | null;
  appearance: DiscoverAppearance | null;
}

/** Under two weeks old — young enough that joining still means shaping it. */
function isNew(createdAt: string | null): boolean {
  if (!createdAt) return false;
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) return false;
  return t > Date.now() - 14 * 24 * 3600 * 1000;
}

/** Deterministic hue from an id, so flairless groups still differ. */
function hueForId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 360;
}

/**
 * The cover band's paint. An explicit gradient only — an accent is not a
 * gradient, and faking one would make every flaired group look the same. No
 * flair falls back to the id-colour, faded across the band.
 */
function bandBackground(entry: DiscoverEntry): string {
  const g = entry.appearance?.gradient;
  if (g && g.length >= 2 && g[0] && g[1]) {
    return `linear-gradient(135deg, ${g[0]}, ${g[1]})`;
  }
  const hue = hueForId(entry.id);
  return `linear-gradient(135deg, hsl(${hue} 65% 62% / 0.85), hsl(${hue} 65% 62% / 0.22))`;
}

function subtitleOf(entry: DiscoverEntry): string {
  const parts: string[] = [];
  if (entry.hereCount > 0) parts.push(`${entry.hereCount} here now`);
  parts.push(`${entry.memberCount} ${entry.memberCount === 1 ? 'member' : 'members'}`);
  if (entry.handle) parts.push(`@${entry.handle}`);
  return parts.join(' · ');
}

export function ExploreScreen() {
  const { state } = useStore('conversations', 'ui');
  const [entries, setEntries] = useState<DiscoverEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [detail, setDetail] = useState<DiscoverEntry | null>(null);
  const [botsOpen, setBotsOpen] = useState(false);
  const [joining, setJoining] = useState<string | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  const seqRef = useRef(0);

  /**
   * What actually goes to the server: a single character matches half the
   * directory and flashes the page on every first keystroke, so search only
   * begins at two.
   */
  const activeQuery = useMemo(() => {
    const trimmed = query.trim();
    return trimmed.length >= 2 ? trimmed : '';
  }, [query]);

  const load = useCallback(async (q: string) => {
    const seq = (seqRef.current += 1);
    setFailed(false);
    try {
      const res = await api<{ conversations: DiscoverEntry[] }>(
        `/conversations/discover?limit=50${q ? `&q=${encodeURIComponent(q)}` : ''}`,
      );
      // A slow browse response must not overwrite a newer search's page.
      if (seq !== seqRef.current) return;
      setEntries(res.conversations);
    } catch {
      if (seq !== seqRef.current) return;
      // "Nothing public yet" is a claim about the world, so a failed fetch may
      // not make it — entries stays as-is and the error state says what
      // actually happened instead.
      setFailed(true);
    }
  }, []);

  // Browse loads once; a query re-asks the server, debounced so a fast typist
  // costs one request, not one per letter. Clearing back to browse is instant.
  useEffect(() => {
    if (activeQuery === '') {
      void load('');
      return;
    }
    const timer = setTimeout(() => void load(activeQuery), 350);
    return () => clearTimeout(timer);
  }, [activeQuery, load]);

  // Esc closes the detail overlay.
  useEffect(() => {
    if (!detail) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDetail(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [detail]);

  const isMember = useCallback((id: string) => state.conversations.has(id), [state]);

  /** Join, then land the person in the room they just walked into. */
  const join = useCallback(
    async (entry: DiscoverEntry) => {
      if (joining) return;
      setJoining(entry.id);
      setJoinError(null);
      try {
        await api(`/conversations/${entry.id}/join`, { method: 'POST' });
        await loadConversations();
        await selectConversation(entry.id);
        mutate((s) => {
          s.view = 'chats';
        });
        setDetail(null);
      } catch {
        setJoinError("Couldn't join — try again in a moment.");
      } finally {
        setJoining(null);
      }
    },
    [joining],
  );

  /** Already a member: no POST, just go there. */
  const open = useCallback(async (entry: DiscoverEntry) => {
    await selectConversation(entry.id);
    mutate((s) => {
      s.view = 'chats';
    });
    setDetail(null);
  }, []);

  /**
   * Sectioned by what matters, in order: the vouched-for, the warm, the fresh,
   * then everything else. A group appears once, in the strongest section it
   * qualifies for. A search collapses to one flat result grid.
   */
  const sections = useMemo(() => {
    const loaded = entries ?? [];
    if (activeQuery !== '') return [{ label: null, icon: null, items: loaded }];
    const verified = loaded.filter((e) => e.badge !== null);
    const rest1 = loaded.filter((e) => e.badge === null);
    const buzzing = rest1.filter((e) => e.hereCount > 0 || e.live);
    const rest2 = rest1.filter((e) => !(e.hereCount > 0 || e.live));
    const fresh = rest2.filter((e) => isNew(e.createdAt));
    const others = rest2.filter((e) => !isNew(e.createdAt));
    const moreLabel =
      verified.length === 0 && buzzing.length === 0 && fresh.length === 0 ? null : 'More places';
    const sectioned: Array<{ label: string | null; icon: IconName | null; items: DiscoverEntry[] }> = [
      { label: 'Verified', icon: 'shield', items: verified },
      { label: 'Buzzing now', icon: 'users', items: buzzing },
      { label: 'New places', icon: 'sparkle', items: fresh },
      { label: moreLabel, icon: moreLabel ? 'compass' : null, items: others },
    ];
    return sectioned.filter((s) => s.items.length > 0);
  }, [entries, activeQuery]);

  return (
    <div className="explore">
      <header className="explore-head">
        <h1 className="brand explore-title">Explore</h1>
        <div className="explore-search">
          <span className="explore-search-icon">
            <Icon name="search" size={16} />
          </span>
          <input
            type="text"
            value={query}
            placeholder="Search public groups"
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search public groups"
          />
        </div>
        <button className="explore-bots-btn" onClick={() => setBotsOpen(true)}>
          <Icon name="sparkle" size={16} />
          Bots
        </button>
      </header>
      {botsOpen && <BotDirectory onClose={() => setBotsOpen(false)} />}

      {failed && entries === null ? (
        <div className="explore-empty">
          <div className="explore-empty-mark">
            <Icon name="compass" size={26} />
          </div>
          <div className="explore-empty-title">Couldn't load Explore</div>
          <button className="btn-accent explore-retry" onClick={() => void load(activeQuery)}>
            Retry
          </button>
        </div>
      ) : entries === null ? (
        <div className="explore-grid" aria-hidden>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="place-card place-card-skeleton" />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <div className="explore-empty">
          <div className="explore-empty-mark">
            <Icon name={activeQuery ? 'search' : 'compass'} size={26} />
          </div>
          <div className="explore-empty-title">
            {activeQuery ? 'Nothing matches' : 'No public places yet'}
          </div>
          <p className="explore-empty-sub">
            {activeQuery
              ? 'Try another name — or start the group you were looking for.'
              : 'Public groups show up here for anyone to walk into. Yours could be first: make a group, then flip it to public in its settings.'}
          </p>
        </div>
      ) : (
        sections.map((section, i) => (
          <section key={section.label ?? `flat-${i}`}>
            {section.label && (
              <h2 className="explore-section-label">
                {section.icon && <Icon name={section.icon} size={15} />}
                {section.label}
              </h2>
            )}
            <div className="explore-grid">
              {section.items.map((entry) => (
                <PlaceCard
                  key={entry.id}
                  entry={entry}
                  member={isMember(entry.id)}
                  onOpen={() => setDetail(entry)}
                />
              ))}
            </div>
          </section>
        ))
      )}

      {detail && (
        <PlaceDetail
          entry={detail}
          member={isMember(detail.id)}
          joining={joining === detail.id}
          error={joinError}
          onClose={() => {
            setDetail(null);
            setJoinError(null);
          }}
          onJoin={() => void join(detail)}
          onEnter={() => void open(detail)}
        />
      )}
    </div>
  );
}

/** One public group, drawn as a cover. Click for the bigger picture. */
function PlaceCard(props: { entry: DiscoverEntry; member: boolean; onOpen: () => void }) {
  const { entry } = props;
  return (
    <button className="place-card" onClick={props.onOpen}>
      <div className="place-band" style={{ background: bandBackground(entry) }}>
        {entry.live && (
          <span className="place-live">
            <span className="place-live-dot" aria-hidden /> LIVE
          </span>
        )}
        {entry.appearance?.emoji && (
          <span className="place-band-emoji" aria-hidden>
            {entry.appearance.emoji}
          </span>
        )}
      </div>
      <div className="place-body">
        <div className="place-avatar-seat">
          <Avatar kind="place" name={entry.title} url={entry.avatarUrl} size={52} />
        </div>
        <div className="place-text">
          <div className="place-title-line">
            <span className="place-title">{entry.title ?? 'Group'}</span>
            {entry.badge && (
              <span className="place-badge" title={entry.badge}>
                <VerifiedSeal size={15} />
              </span>
            )}
            {props.member && <span className="place-member-chip">joined</span>}
          </div>
          <div className={`place-sub${entry.hereCount > 0 ? ' warm' : ''}`}>
            {subtitleOf(entry)}
          </div>
          {entry.description && <div className="place-desc">{entry.description}</div>}
        </div>
      </div>
    </button>
  );
}

/** The bigger card: full description, stats, and the door itself. */
function PlaceDetail(props: {
  entry: DiscoverEntry;
  member: boolean;
  joining: boolean;
  error: string | null;
  onClose: () => void;
  onJoin: () => void;
  onEnter: () => void;
}) {
  const { entry } = props;
  return (
    <div
      className="place-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={entry.title ?? 'Group'}
    >
      <div className="place-sheet">
        <div className="place-band place-sheet-band" style={{ background: bandBackground(entry) }}>
          {entry.live && (
            <span className="place-live">
              <span className="place-live-dot" aria-hidden /> LIVE
            </span>
          )}
          {entry.appearance?.emoji && (
            <span className="place-band-emoji place-sheet-emoji" aria-hidden>
              {entry.appearance.emoji}
            </span>
          )}
          <button className="place-close" onClick={props.onClose} aria-label="Close">
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="place-sheet-body">
          <div className="place-avatar-seat place-sheet-seat">
            <Avatar kind="place" name={entry.title} url={entry.avatarUrl} size={72} />
          </div>
          <div className="place-sheet-title-line">
            <h2 className="place-sheet-title">{entry.title ?? 'Group'}</h2>
            {entry.badge && (
              <span className="place-badge big" title={entry.badge}>
                <VerifiedSeal size={19} />
              </span>
            )}
          </div>
          {entry.handle && <div className="place-sheet-handle">@{entry.handle}</div>}
          <div className="place-stats">
            <div className="place-stat">
              <div className="place-stat-num">{entry.memberCount}</div>
              <div className="place-stat-label">{entry.memberCount === 1 ? 'member' : 'members'}</div>
            </div>
            <div className="place-stat">
              <div className={`place-stat-num${entry.hereCount > 0 ? ' warm' : ''}`}>
                {entry.hereCount}
              </div>
              <div className="place-stat-label">here now</div>
            </div>
            {entry.live && (
              <div className="place-stat">
                <div className="place-stat-num live">
                  <span className="place-live-dot big" aria-hidden />
                </div>
                <div className="place-stat-label">live call</div>
              </div>
            )}
          </div>
          {entry.description && <p className="place-sheet-desc">{entry.description}</p>}
          {props.error && <div className="place-join-error">{props.error}</div>}
          {props.member ? (
            <button className="btn-accent place-join" onClick={props.onEnter}>
              Open
            </button>
          ) : (
            <button
              className="btn-accent place-join"
              disabled={props.joining}
              onClick={props.onJoin}
            >
              {props.joining ? 'Joining…' : 'Join'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
