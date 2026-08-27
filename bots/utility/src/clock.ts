/**
 * Time, said the way people say it.
 *
 * Everything here is `Intl` and arithmetic — no dependency, no table of zone
 * offsets to go stale twice a year. The one rule the whole file follows: parse
 * generously, then *say back* what was understood. "in 20 minutes — 9:41 PM"
 * is the difference between a reminder someone trusts and one they set twice.
 */

const UNIT_MS: Record<string, number> = {
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
  w: 604_800_000,
  week: 604_800_000,
  weeks: 604_800_000,
};

/** Common shorthands. A person writing "3pm PT" should not have to know IANA. */
const ZONE_ALIASES: Record<string, string> = {
  utc: 'UTC',
  gmt: 'UTC',
  z: 'UTC',
  pt: 'America/Los_Angeles',
  pst: 'America/Los_Angeles',
  pdt: 'America/Los_Angeles',
  mt: 'America/Denver',
  mst: 'America/Denver',
  ct: 'America/Chicago',
  cst: 'America/Chicago',
  et: 'America/New_York',
  est: 'America/New_York',
  edt: 'America/New_York',
  uk: 'Europe/London',
  bst: 'Europe/London',
  london: 'Europe/London',
  cet: 'Europe/Berlin',
  cest: 'Europe/Berlin',
  berlin: 'Europe/Berlin',
  paris: 'Europe/Paris',
  msk: 'Europe/Moscow',
  gst: 'Asia/Dubai',
  dubai: 'Asia/Dubai',
  pkt: 'Asia/Karachi',
  karachi: 'Asia/Karachi',
  ist: 'Asia/Kolkata',
  india: 'Asia/Kolkata',
  sgt: 'Asia/Singapore',
  hkt: 'Asia/Hong_Kong',
  jst: 'Asia/Tokyo',
  tokyo: 'Asia/Tokyo',
  kst: 'Asia/Seoul',
  aest: 'Australia/Sydney',
  aedt: 'Australia/Sydney',
  sydney: 'Australia/Sydney',
  nzst: 'Pacific/Auckland',
};

/** The board `/time` draws. Wide enough to cover a group, short enough to read. */
export const WORLD: Array<{ label: string; zone: string }> = [
  { label: 'Los Angeles', zone: 'America/Los_Angeles' },
  { label: 'New York', zone: 'America/New_York' },
  { label: 'London', zone: 'Europe/London' },
  { label: 'Berlin', zone: 'Europe/Berlin' },
  { label: 'Dubai', zone: 'Asia/Dubai' },
  { label: 'Karachi', zone: 'Asia/Karachi' },
  { label: 'Singapore', zone: 'Asia/Singapore' },
  { label: 'Tokyo', zone: 'Asia/Tokyo' },
  { label: 'Sydney', zone: 'Australia/Sydney' },
];

export function resolveZone(input: string | undefined | null): string | null {
  if (!input) return null;
  const key = input.trim().toLowerCase();
  const alias = ZONE_ALIASES[key];
  if (alias) return alias;
  // Anything else has to be a real IANA name, and `Intl` is the authority on
  // that. Asking it is cheaper than carrying a list that goes stale.
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: input.trim() });
    return input.trim();
  } catch {
    return null;
  }
}

/** What a zone's clock reads at this instant, as parts. */
function partsIn(zone: string, at: Date): { year: number; month: number; day: number; hour: number; minute: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const got: Record<string, string> = {};
  for (const part of fmt.formatToParts(at)) got[part.type] = part.value;
  return {
    year: Number(got.year),
    month: Number(got.month),
    day: Number(got.day),
    // `hour12: false` renders midnight as 24 in some environments.
    hour: Number(got.hour) % 24,
    minute: Number(got.minute),
  };
}

/**
 * The instant at which `zone`'s wall clock reads this local time.
 *
 * There is no "make a Date in another zone" in JavaScript, so this guesses UTC,
 * asks what the guess reads as in the target zone, and corrects by the
 * difference. Twice, because the first correction can cross a DST boundary and
 * change the offset it was correcting for.
 */
export function zonedTime(
  zone: string,
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
): Date {
  let ts = Date.UTC(y, mo - 1, d, h, mi, 0, 0);
  for (let i = 0; i < 2; i += 1) {
    const seen = partsIn(zone, new Date(ts));
    const seenAsUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, 0, 0);
    const drift = Date.UTC(y, mo - 1, d, h, mi, 0, 0) - seenAsUtc;
    if (drift === 0) break;
    ts += drift;
  }
  return new Date(ts);
}

export interface Understood {
  /** When it lands. */
  at: Date;
  /** What was left over — the actual reminder text. */
  rest: string;
  /** How to say it back: "in 20 minutes", "at 9:00 PM tomorrow". */
  said: string;
}

const DURATION_RE = /^(\d+(?:\.\d+)?)\s*([a-z]+)/i;
const CLOCK_RE = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i;

/**
 * Read a leading time expression and return the rest of the line.
 *
 * Accepts `20m`, `1h30m`, `in 45 minutes`, `at 9pm`, `9:30`, `tomorrow 8am`,
 * and any of those with a trailing zone (`9pm PT`). Returns null when the
 * front of the string is not a time at all, which is how the caller knows to
 * complain rather than guess.
 */
export function parseWhen(input: string, zone: string, now = new Date()): Understood | null {
  let text = input.trim();
  if (!text) return null;

  // "in ..." is noise that makes the rest read naturally.
  text = text.replace(/^in\s+/i, '');

  let tomorrow = false;
  if (/^tomorrow\b/i.test(text)) {
    tomorrow = true;
    text = text.replace(/^tomorrow\s*/i, '');
  }
  if (/^tonight\b/i.test(text)) text = text.replace(/^tonight\s*/i, '');

  const atPrefixed = /^at\s+/i.test(text);
  if (atPrefixed) text = text.replace(/^at\s+/i, '');

  // ── A duration: 20m, 1h30m, 2 hours ───────────────────────────────────────
  if (!atPrefixed && !tomorrow) {
    let total = 0;
    let rest = text;
    for (;;) {
      const match = DURATION_RE.exec(rest);
      if (!match) break;
      const unit = UNIT_MS[match[2]!.toLowerCase()];
      if (unit === undefined) break;
      total += Number(match[1]) * unit;
      rest = rest.slice(match[0].length).trim();
      // "1h30m" and "1h 30m" both continue; "20m pizza" stops here.
      if (!DURATION_RE.test(rest)) break;
    }
    if (total > 0) {
      return {
        at: new Date(now.getTime() + total),
        rest: rest.replace(/^(to|that)\s+/i, '').trim(),
        said: `in ${formatDuration(total)}`,
      };
    }
  }

  // ── A clock time: 9pm, 09:30, 21:00 [zone] ────────────────────────────────
  const clock = CLOCK_RE.exec(text);
  if (clock) {
    let hour = Number(clock[1]);
    const minute = Number(clock[2] ?? 0);
    const meridiem = clock[3]?.toLowerCase();
    if (hour > 23 || minute > 59) return null;
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    // A bare "9" is not a time — "/remind 9 things" means nine of something.
    if (!meridiem && !clock[2]) return null;

    let rest = text.slice(clock[0].length).trim();

    // An optional zone right after the time: "9pm PT do the thing".
    let target = zone;
    const zoneWord = /^([A-Za-z_]+(?:\/[A-Za-z_]+)?)\b/.exec(rest);
    if (zoneWord) {
      const resolved = resolveZone(zoneWord[1]);
      if (resolved) {
        target = resolved;
        rest = rest.slice(zoneWord[0].length).trim();
      }
    }

    const here = partsIn(target, now);
    let at = zonedTime(target, here.year, here.month, here.day, hour, minute);
    // Either they said tomorrow, or the time has already gone today — "9am"
    // typed at noon means the next 9am, not one this morning.
    if (tomorrow || at.getTime() <= now.getTime()) {
      at = zonedTime(target, here.year, here.month, here.day + 1, hour, minute);
    }

    return {
      at,
      rest: rest.replace(/^(to|that)\s+/i, '').trim(),
      said: `at ${formatClock(target, at)}${sameDay(target, now, at) ? '' : ' tomorrow'}${
        target === zone ? '' : ` ${target}`
      }`,
    };
  }

  return null;
}

function sameDay(zone: string, a: Date, b: Date): boolean {
  const x = partsIn(zone, a);
  const y = partsIn(zone, b);
  return x.year === y.year && x.month === y.month && x.day === y.day;
}

/** "9:41 PM" in that zone. */
export function formatClock(zone: string, at: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(at);
}

/** "Thu 9:41 PM" — for anything that might not be today. */
export function formatStamp(zone: string, at: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(at);
}

/** "1h 30m", "45s", "2d 3h". Two units is as much as anyone reads. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;

  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  // Seconds only matter while nothing bigger is on screen: "1m 30s" is useful,
  // "2d 3h 14m 9s" is a stopwatch nobody asked for.
  if (seconds && !days && !hours) parts.push(`${seconds}s`);
  if (parts.length === 0) parts.push('0s');
  return parts.slice(0, 2).join(' ');
}
