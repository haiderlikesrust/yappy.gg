/**
 * Fenced code blocks.
 *
 * The rest of markdown.ts is board-only, deliberately. Fences are not: nobody
 * writes three backticks in a sentence by accident, so this pass runs on every
 * message — which is the point, because a chat is where people paste code.
 *
 *   node --import tsx --test packages/shared/src/markdown.test.ts
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { codeBlocksToEntities, parseCodeBlocks } from './markdown.js';

const F = '```';

describe('parseCodeBlocks', () => {
  it('lifts a block out and leaves the prose', () => {
    const { text, entities } = parseCodeBlocks(`look:\n${F}\nconst a = 1;\n${F}\nthat`);
    assert.equal(text, 'look:\nconst a = 1;\nthat');
    assert.equal(entities.length, 1);
    assert.equal(text.slice(entities[0]!.offset, entities[0]!.offset + entities[0]!.length), 'const a = 1;');
  });

  it('carries the language on the entity, not in the text', () => {
    const { text, entities } = parseCodeBlocks(`${F}python\nprint(1)\n${F}`);
    assert.equal(text, 'print(1)');
    assert.equal(entities[0]!.language, 'python');
  });

  it('keeps the blank lines inside a block', () => {
    const { text } = parseCodeBlocks(`${F}\na\n\nb\n${F}`);
    assert.equal(text, 'a\n\nb');
  });

  it('handles two blocks in one message', () => {
    const { text, entities } = parseCodeBlocks(`${F}\none\n${F} and ${F}\ntwo\n${F}`);
    assert.equal(entities.length, 2);
    assert.equal(text.slice(entities[0]!.offset, entities[0]!.offset + entities[0]!.length), 'one');
    assert.equal(text.slice(entities[1]!.offset, entities[1]!.offset + entities[1]!.length), 'two');
  });

  it('leaves an unclosed fence alone', () => {
    const input = `${F}\nnever closed`;
    assert.deepEqual(parseCodeBlocks(input), { text: input, entities: [] });
  });

  it('does not treat prose after a fence as a language', () => {
    // "see below" has a space in it, so it is a sentence, not an annotation.
    const { entities } = parseCodeBlocks(`${F} see below\nx\n${F}`);
    assert.equal(entities.length, 0);
  });

  it('drops an empty block rather than emitting a zero-length span', () => {
    const { entities } = parseCodeBlocks(`${F}\n${F}`);
    assert.equal(entities.length, 0);
  });
});

describe('codeBlocksToEntities', () => {
  it('is null when there is no fence, which is almost every message', () => {
    assert.equal(codeBlocksToEntities('just talking', []), null);
    assert.equal(codeBlocksToEntities(null, []), null);
  });

  it('moves an existing mention to where it ended up', () => {
    /*
     * The whole reason this cannot bail on existing entities the way
     * markdownToEntities does: a client computes its mentions before it sends,
     * and refusing to parse a fence because somebody was named would make code
     * blocks work only in messages with nobody in them.
     */
    const text = `@sam look:\n${F}\nx = 1\n${F}\nthanks`;
    const mention = { type: 'mention', offset: 0, length: 4, userId: 'u1' };
    const out = codeBlocksToEntities(text, [mention])!;

    const moved = (out.entities as Array<{ type: string; offset: number; length: number }>).find(
      (e) => e.type === 'mention',
    )!;
    assert.equal(out.content.slice(moved.offset, moved.offset + moved.length), '@sam');

    const pre = (out.entities as Array<{ type: string; offset: number; length: number }>).find(
      (e) => e.type === 'pre',
    )!;
    assert.equal(out.content.slice(pre.offset, pre.offset + pre.length), 'x = 1');
  });

  it('moves a mention that sits after the block', () => {
    const text = `${F}\nx = 1\n${F}\nthanks @sam`;
    const at = text.indexOf('@sam');
    const out = codeBlocksToEntities(text, [
      { type: 'mention', offset: at, length: 4, userId: 'u1' },
    ])!;
    const moved = (out.entities as Array<{ type: string; offset: number; length: number }>).find(
      (e) => e.type === 'mention',
    )!;
    assert.equal(out.content.slice(moved.offset, moved.offset + moved.length), '@sam');
  });

  it('returns entities in offset order, which every renderer assumes', () => {
    const text = `@sam\n${F}\nx\n${F}\n@kim`;
    const out = codeBlocksToEntities(text, [
      { type: 'mention', offset: 0, length: 4, userId: 'u1' },
      { type: 'mention', offset: text.indexOf('@kim'), length: 4, userId: 'u2' },
    ])!;
    const offsets = (out.entities as Array<{ offset: number }>).map((e) => e.offset);
    assert.deepEqual(offsets, [...offsets].sort((a, b) => a - b));
  });
});
