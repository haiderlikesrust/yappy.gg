import { useId } from 'react';
import type { PublicUser } from '../lib/types';
import './badges.css';

/**
 * Identity marks — the web port of Android's Badge.kt, drawn the same way.
 *
 * Two different claims, drawn differently on purpose:
 *
 *   badge       — the platform vouching for an account. A scalloped seal.
 *   affiliation — a *group* vouching for a person. The group's own logo in
 *                 the squircle that means "place" everywhere else.
 *
 * The seal is the union of a core disc and nine lobes — filling overlapping
 * circles unions them for free, and the shape stays legible down to 12px.
 * Marks with a letter (y, β, <>) say "this is what they are"; verified and
 * partner carry the check.
 */

export const BADGE_PRECEDENCE = ['staff', 'partner', 'verified', 'yapper', 'developer', 'beta'];

export const BADGE_LABEL: Record<string, string> = {
  verified: 'Verified',
  partner: 'yappy partner',
  staff: 'yappy staff',
  yapper: 'OG yapper',
  beta: 'Beta tester',
  developer: 'Bot developer',
};

export const BADGE_DESCRIPTION: Record<string, string> = {
  verified: 'yappy confirmed this account is who it says it is.',
  partner: 'Part of the yappy partner programme.',
  staff: 'Works on yappy.',
  yapper: 'Here early, when yappy was small.',
  beta: 'Tests builds before anybody else has to.',
  developer: 'Has built a bot on the platform.',
};

/** [from, to] gradient stops; flat marks repeat the colour. Mirrors Android. */
const BADGE_FILL: Record<string, [string, string]> = {
  partner: ['#8b7cff', '#ff6bd6'],
  staff: ['#ffb224', '#ffb224'],
  // Warm gold, only for this one: "was here first" cannot be earned again.
  yapper: ['#f7b733', '#fc4a1a'],
  beta: ['#3dd68c', '#3dd68c'],
  developer: ['#00b4d8', '#0077b6'],
  verified: ['#8b7cff', '#8b7cff'],
};

const BADGE_GLYPH: Record<string, string> = {
  staff: 'y',
  yapper: 'y',
  beta: 'β',
  developer: '<>',
};

const GLYPH_COLOR = '#14121f';

/** The nine-lobed seal, in a 24-unit box. */
function sealLobes(): Array<{ cx: number; cy: number }> {
  const out: Array<{ cx: number; cy: number }> = [];
  for (let i = 0; i < 9; i++) {
    const angle = (2 * Math.PI * i) / 9 - Math.PI / 2;
    out.push({ cx: 12 + Math.cos(angle) * 8.4, cy: 12 + Math.sin(angle) * 8.4 });
  }
  return out;
}
const LOBES = sealLobes();

/**
 * One badge. Renders nothing for an unknown or absent kind, so call sites
 * can pass the raw wire string — a kind added by a newer server simply does
 * not appear rather than breaking the row.
 */
export function BadgeMark(props: { badge: string | null | undefined; size?: number }) {
  const gradientId = useId();
  const { badge, size = 15 } = props;
  if (!badge || !BADGE_LABEL[badge]) return null;

  const [from, to] = BADGE_FILL[badge] ?? ['#8b7cff', '#8b7cff'];
  const glyph = BADGE_GLYPH[badge];
  const fill = from === to ? from : `url(#${gradientId})`;

  return (
    <svg
      className="badge-mark"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label={BADGE_LABEL[badge]}
    >
      <title>{BADGE_LABEL[badge]}</title>
      {from !== to && (
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor={from} />
            <stop offset="1" stopColor={to} />
          </linearGradient>
        </defs>
      )}
      <circle cx="12" cy="12" r="8.64" fill={fill} />
      {LOBES.map((l, i) => (
        <circle key={i} cx={l.cx} cy={l.cy} r="3.6" fill={fill} />
      ))}
      {glyph ? (
        <text
          x="12"
          y="12.4"
          textAnchor="middle"
          dominantBaseline="central"
          fontFamily="var(--font-display), sans-serif"
          fontWeight="700"
          fontSize={glyph.length > 1 ? 10 : 14.5}
          fill={GLYPH_COLOR}
        >
          {glyph}
        </text>
      ) : (
        <path
          d="M7.4 12.2 L10.6 15.4 L16.8 8.9"
          fill="none"
          stroke={GLYPH_COLOR}
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

/**
 * Every badge somebody holds, platform order, capped at three — past that a
 * name row turns into a trophy cabinet. What gets dropped mattered least.
 */
export function BadgeMarks(props: { badges: string[]; size?: number; max?: number }) {
  const ordered = BADGE_PRECEDENCE.filter((b) => props.badges.includes(b)).slice(
    0,
    props.max ?? 3,
  );
  if (ordered.length === 0) return null;
  return (
    <span className="badge-row">
      {ordered.map((b) => (
        <BadgeMark key={b} badge={b} size={props.size} />
      ))}
    </span>
  );
}

/** What somebody actually holds, whichever field the server filled in. */
export function heldBadges(user: { badge?: string | null; badges?: string[] }): string[] {
  if (user.badges && user.badges.length > 0) return user.badges;
  return user.badge ? [user.badge] : [];
}

/** "BOT", next to a name — part of the name anywhere a name is drawn. */
export function BotTag(props: { size?: number }) {
  const size = props.size ?? 15;
  return (
    <span className="bot-tag" style={{ fontSize: Math.max(8, size * 0.6) }}>
      BOT
    </span>
  );
}

/** The affiliated group's logo — a squircle, because a squircle is a place. */
export function AffiliateMark(props: {
  affiliation: PublicUser['affiliation'];
  size?: number;
}) {
  const a = props.affiliation;
  if (!a) return null;
  const size = props.size ?? 15;
  return a.avatarUrl ? (
    <img
      className="affiliate-mark"
      src={a.avatarUrl}
      width={size}
      height={size}
      alt={a.title ?? 'group'}
      title={a.title ?? undefined}
      loading="lazy"
    />
  ) : (
    <span
      className="affiliate-mark affiliate-mark-fallback"
      style={{ width: size, height: size, fontSize: size * 0.55 }}
      title={a.title ?? undefined}
    >
      {(a.title ?? '?').slice(0, 1)}
    </span>
  );
}

/**
 * Everything that goes after a name, in a fixed order: affiliation first
 * (whose it is), then the badge (what they are), then BOT (what it is).
 * Emits nothing when there is nothing to show, so it drops into any row.
 *
 * One seal by default: in a row, the *primary* mark speaks for somebody —
 * precedence picks it, same as the server's `primaryBadge` — and the full
 * set belongs on the profile, where each mark explains itself. Three seals
 * after a name is a trophy shelf, and the name stops being what you read.
 */
export function IdentityMarks(props: {
  user: PublicUser | null | undefined;
  size?: number;
  showsBot?: boolean;
  /** How many seals may follow the name. Rows keep the default of one. */
  max?: number;
}) {
  const { user, size = 15, showsBot = true, max = 1 } = props;
  if (!user) return null;
  const badges = heldBadges(user);
  const bot = showsBot && user.isBot;
  if (badges.length === 0 && !user.affiliation && !bot) return null;
  return (
    <span className="identity-marks">
      <AffiliateMark affiliation={user.affiliation} size={size} />
      <BadgeMarks badges={badges} size={size} max={max} />
      {bot && <BotTag size={size} />}
    </span>
  );
}
