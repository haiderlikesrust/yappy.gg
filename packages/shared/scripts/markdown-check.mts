import { parseMarkdown } from '../src/markdown.js';

/**
 * The markdown subset, and the things a naive parser gets wrong.
 *
 * Round-tripping `**bold**` proves nothing — every parser does that. What is
 * checked here is the arithmetic (`2 * 3 * 4`), the identifiers
 * (`snake_case_name`), the unclosed marker, and the offsets, because an offset
 * that is one out renders the wrong half of a sentence bold on three platforms
 * at once.
 *
 *   pnpm --filter @yappy/shared markdown-check
 */

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${name}${detail && !ok ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

const spans = (input: string) => {
  const { text, entities } = parseMarkdown(input);
  return entities.map((e) => `${e.type}:${text.slice(e.offset, e.offset + e.length)}`).join(' ');
};

// ─── it reads what it should ────────────────────────────────────────────────

check('bold', spans('say **this** loudly') === 'bold:this');
check('italic with underscores', spans('say _this_ softly') === 'italic:this');
check('italic with asterisks', spans('say *this* softly') === 'italic:this');
check('strike', spans('~~gone~~') === 'strike:gone');
check('spoiler', spans('||hidden||') === 'spoiler:hidden');
check('inline code', spans('run `npm test` now') === 'code:npm test');
check('a link', spans('see [the docs](https://yappy.gg/docs)') === 'link:the docs');
check(
  'the link keeps its url',
  parseMarkdown('[docs](https://yappy.gg/x)').entities[0]?.type === 'link' &&
    (parseMarkdown('[docs](https://yappy.gg/x)').entities[0] as { url: string }).url ===
      'https://yappy.gg/x',
);

check('several in one line', spans('**a** and _b_ and `c`') === 'bold:a italic:b code:c');

// ─── the markers come out of the text ───────────────────────────────────────

const bold = parseMarkdown('say **this** loudly');
check('the asterisks are gone from the text', bold.text === 'say this loudly', bold.text);
check(
  'and the offset points at the right word',
  bold.text.slice(bold.entities[0]!.offset, bold.entities[0]!.offset + bold.entities[0]!.length) ===
    'this',
);

const mixed = parseMarkdown('**a** and _b_');
check('offsets stay right after earlier markers are removed', mixed.text === 'a and b', mixed.text);
check(
  'the second span still lands on its word',
  mixed.text.slice(mixed.entities[1]!.offset, mixed.entities[1]!.offset + mixed.entities[1]!.length) ===
    'b',
);

// ─── the things that are not markdown ───────────────────────────────────────

check('arithmetic is not italic', spans('2 * 3 * 4 = 24') === '', spans('2 * 3 * 4 = 24'));
check('an identifier is not italic', spans('snake_case_name here') === '', spans('snake_case_name here'));
check('a lone marker is left alone', spans('unclosed **bold') === '');
check('and the text keeps it', parseMarkdown('unclosed **bold').text === 'unclosed **bold');
check('an empty pair is nothing', spans('****') === '');
check('a bare price survives', parseMarkdown('SOL $142 * 2').text === 'SOL $142 * 2');

// The classic: two bolds must not read as four italics.
check('two bolds are two bolds', spans('**a** **b**') === 'bold:a bold:b');

// ─── longest marker first ───────────────────────────────────────────────────

check('a fence is code, not two italics', spans('```x```') === 'code:x');
check('double underscore is bold, not two italics', spans('__a__') === 'bold:a');

console.log(failures === 0 ? '\nall green' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
