/**
 * Markdown, parsed once, into the entities every client already carries.
 *
 * A board is a page, and a page needs emphasis, links and code. The obvious way
 * to get them is to render markdown in the client — and then to render it again
 * in the Android client, and a third time in Swift, and to spend the next year
 * discovering that one of the three treats `**a *b* c**` differently from the
 * other two.
 *
 * So it is parsed here, once, on the way in. What clients receive is what they
 * already know how to handle: plain text plus a list of spans saying which
 * stretches are bold, which are links. `messages.entities` has carried exactly
 * that shape since mentions were added; this only starts filling in the other
 * types it already declares.
 *
 * The markers are removed from the text, the way Telegram does it, so offsets
 * refer to what the reader actually sees. A client that renders no entities at
 * all still shows clean prose rather than a page of asterisks.
 *
 * ## The subset
 *
 * `**bold**`, `_italic_`, `~~strike~~`, `` `code` ``, `[text](url)`, and
 * `||spoiler||`. Inline only: headings and lists are block-level and have no
 * entity type to become, so they are left as the literal characters somebody
 * typed rather than half-supported.
 *
 * Offsets are UTF-16 code units, matching what `String.length` means in
 * JavaScript and Kotlin. Swift counts graphemes and has to convert — see the
 * renderer there.
 */

/** The inline styles, which is everything a marker can produce. */
export type StyleEntityType = 'bold' | 'italic' | 'strike' | 'spoiler' | 'code';

export type TextEntity =
  | { type: StyleEntityType; offset: number; length: number }
  | { type: 'link'; offset: number; length: number; url: string };

export interface ParsedMarkdown {
  text: string;
  entities: TextEntity[];
}

interface Marker {
  open: string;
  close: string;
  /** A marker is never a link — those have their own syntax and carry a url. */
  type: StyleEntityType;
  /**
   * Whether this marker may start in the middle of a word.
   *
   * False for underscores, and that single flag is the whole reason
   * `snake_case_name` survives contact with a markdown parser. Asterisks keep
   * it, because `a**b**c` is a thing people write on purpose and no common
   * identifier contains one.
   */
  intraword: boolean;
}

/**
 * Every marker, longest first.
 *
 * Order is load-bearing: `**` has to be tried before `*`, or every bold pair
 * reads as two italics wrapping nothing. Same for `__` before `_`, and for the
 * fence before a single backtick.
 */
const INLINE: Marker[] = [
  { open: '```', close: '```', type: 'code', intraword: true },
  { open: '**', close: '**', type: 'bold', intraword: true },
  { open: '~~', close: '~~', type: 'strike', intraword: true },
  { open: '||', close: '||', type: 'spoiler', intraword: true },
  { open: '`', close: '`', type: 'code', intraword: true },
  { open: '__', close: '__', type: 'bold', intraword: false },
  { open: '_', close: '_', type: 'italic', intraword: false },
  { open: '*', close: '*', type: 'italic', intraword: true },
];

/** `[label](https://…)`, with a URL that cannot contain a closing bracket. */
const LINK = /^\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/;

/**
 * Whether a marker at this position opens something.
 *
 * An opener needs a non-space immediately after it and a closer needs one
 * immediately before — the rule that stops `2 * 3 * 4` turning italic, which is
 * the first thing a naive parser gets wrong.
 */
const WORDISH = /[\p{L}\p{N}_]/u;

function opensAt(text: string, at: number, marker: Marker): boolean {
  const after = text[at + marker.open.length];
  if (after === undefined || /\s/.test(after)) return false;
  if (marker.intraword) return true;
  // Nothing wordish immediately before it, or this is the middle of a name.
  const before = text[at - 1];
  return before === undefined || !WORDISH.test(before);
}

function closerAt(text: string, from: number, marker: Marker): number {
  let at = text.indexOf(marker.close, from);
  while (at !== -1) {
    const before = text[at - 1];
    const after = text[at + marker.close.length];
    const closes = before !== undefined && !/\s/.test(before);
    // The mirror of the opening rule: an underscore run has to end a word,
    // not sit inside one.
    const clean = marker.intraword || after === undefined || !WORDISH.test(after);
    if (closes && clean) return at;
    at = text.indexOf(marker.close, at + 1);
  }
  return -1;
}

/**
 * Plain text and the spans over it.
 *
 * Nested emphasis is deliberately not supported: the inner markers survive as
 * literal characters. Supporting it means a real parser with a stack and a
 * grammar, three times over, for `**bold with *italic* inside**` — which
 * nobody writes on a status board.
 */
export function parseMarkdown(input: string): ParsedMarkdown {
  let text = '';
  const entities: TextEntity[] = [];
  let i = 0;

  outer: while (i < input.length) {
    const rest = input.slice(i);

    const link = LINK.exec(rest);
    if (link) {
      entities.push({ type: 'link', offset: text.length, length: link[1]!.length, url: link[2]! });
      text += link[1];
      i += link[0].length;
      continue;
    }

    for (const marker of INLINE) {
      if (!rest.startsWith(marker.open) || !opensAt(input, i, marker)) continue;
      const end = closerAt(input, i + marker.open.length, marker);
      if (end === -1) continue;

      const body = input.slice(i + marker.open.length, end);
      if (body.length === 0) continue;

      entities.push({ type: marker.type, offset: text.length, length: body.length });
      text += body;
      i = end + marker.close.length;
      continue outer;
    }

    text += input[i];
    i += 1;
  }

  return { text, entities };
}

/**
 * Markdown folded into whatever entities were already there.
 *
 * Existing entities — mentions, mostly — are offsets into the *original* text,
 * and stripping markers moves everything after them. Rather than try to shift
 * them, a message that arrives with entities is left alone entirely: it came
 * from a client that computed its own spans, and second-guessing those is how
 * a mention ends up highlighting the wrong name.
 */
export function markdownToEntities(
  content: string | null | undefined,
  existing: unknown,
): { content: string | null; entities: unknown } | null {
  if (!content) return null;
  if (Array.isArray(existing) && existing.length > 0) return null;

  const parsed = parseMarkdown(content);
  if (parsed.entities.length === 0) return null;
  return { content: parsed.text, entities: parsed.entities };
}
