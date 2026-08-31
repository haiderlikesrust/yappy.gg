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
/**
 * Fenced code blocks, which are a different proposition to the rest of this
 * file.
 *
 * Everything above is board-only, because people type asterisks around words
 * for reasons that have nothing to do with formatting and eating them out of
 * a sentence is worse than not supporting markdown at all. A fence is not
 * like that: nobody puts three backticks in a sentence by accident, and
 * somebody who does is asking for a code block. So this pass runs on every
 * message, in chat as well as on a board — which is the point, because a
 * chat is exactly where people paste code.
 *
 * The opening fence may name a language. It is carried on the entity rather
 * than left in the text: the reader wants the code, not the word `python`
 * sitting above it.
 *
 * Offsets are UTF-16 code units, like the rest of this file.
 */
const FENCE = "```";

export interface ParsedCode {
  text: string;
  entities: Array<{ type: 'pre'; offset: number; length: number; language?: string | null }>;
}

export function parseCodeBlocks(input: string): ParsedCode {
  const entities: ParsedCode['entities'] = [];
  let text = '';
  let i = 0;

  while (i < input.length) {
    const open = input.indexOf(FENCE, i);
    if (open === -1) break;

    // The rest of the opening line is the language, if anything.
    const lineEnd = input.indexOf('\n', open + FENCE.length);
    if (lineEnd === -1) break;
    const language = input.slice(open + FENCE.length, lineEnd).trim();
    // A "language" with a space in it is prose that happened to follow a
    // fence, not an annotation. Refusing it keeps ```` see below` from
    // claiming half a sentence as a label.
    if (language.includes(' ')) { i = open + FENCE.length; continue; }

    const close = input.indexOf(FENCE, lineEnd + 1);
    if (close === -1) break;

    text += input.slice(i, open);
    /*
     * The body, without the newline that ends the opening fence line and
     * without the one before the closing fence. Both belong to the markers
     * rather than to the code, and leaving them in gives every block a blank
     * first and last line.
     */
    let body = input.slice(lineEnd + 1, close);
    if (body.endsWith('\n')) body = body.slice(0, -1);

    if (body.length > 0) {
      entities.push({
        type: 'pre',
        offset: text.length,
        length: body.length,
        ...(language ? { language } : {}),
      });
      text += body;
    }
    i = close + FENCE.length;
  }

  text += input.slice(i);
  return { text, entities };
}

/**
 * Code blocks, for every message rather than only a board.
 *
 * Returns null when there is nothing to do, which is almost always — the
 * caller then leaves the message exactly as it arrived.
 *
 * Unlike `markdownToEntities` this does *not* bail when the message already
 * has entities. A client computes mentions before it sends, and refusing to
 * parse a fence because somebody was also named in the message would make the
 * feature work only in messages with nobody in them. Existing entities are
 * shifted by what the fences removed instead.
 */
export function codeBlocksToEntities(
  content: string | null | undefined,
  existing: unknown,
): { content: string; entities: unknown } | null {
  if (!content || !content.includes(FENCE)) return null;

  const parsed = parseCodeBlocks(content);
  if (parsed.entities.length === 0) return null;

  /*
   * Where each original offset lands once the fences are gone.
   *
   * Built by walking the original and the stripped text together. An entity
   * that pointed *into* a fence marker has nothing left to point at and is
   * dropped — the alternative is a mention span covering a stray backtick.
   */
  const shifted: unknown[] = [];
  if (Array.isArray(existing)) {
    const map = offsetMap(content, parsed.text);
    for (const e of existing as Array<{ offset?: number; length?: number }>) {
      if (typeof e?.offset !== 'number' || typeof e?.length !== 'number') continue;
      const from = map[e.offset];
      const to = map[e.offset + e.length];
      if (from === undefined || to === undefined || to <= from) continue;
      shifted.push({ ...e, offset: from, length: to - from });
    }
  }

  const all = [...shifted, ...parsed.entities].sort(
    (a, b) => (a as { offset: number }).offset - (b as { offset: number }).offset,
  );
  return { content: parsed.text, entities: all };
}

/**
 * original index → stripped index, for every position that survived.
 *
 * A plain two-pointer walk: the stripped text is the original with runs
 * removed and nothing reordered, so matching characters in order is enough.
 */
function offsetMap(original: string, stripped: string): Record<number, number> {
  const map: Record<number, number> = {};
  let a = 0;
  let b = 0;
  while (a < original.length && b < stripped.length) {
    if (original[a] === stripped[b]) {
      map[a] = b;
      b += 1;
    }
    a += 1;
  }
  map[original.length] = stripped.length;
  return map;
}

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
