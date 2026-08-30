import type { ChartKind, ChartPoint } from '@yappydotgg/bot-sdk';
import { card } from '../cards.js';
import { say, type Command } from './types.js';

const KINDS: ChartKind[] = ['line', 'area', 'bar', 'pie', 'donut', 'scatter'];

/**
 * Numbers as somebody would type them into a chat.
 *
 * `mon=3 tue=5`, `mon: 3, tue: 5`, or bare `3 5 9` — all the same chart. The
 * labels are whatever was on the left; bare numbers get positions.
 */
function parsePoints(input: string): ChartPoint[] {
  const points: ChartPoint[] = [];
  const chunks = input.split(/[,;]|\s+(?=[^\s=:]+\s*[=:])/g);

  for (const chunk of chunks) {
    const piece = chunk.trim();
    if (!piece) continue;

    const pair = /^(.+?)\s*[=:]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(piece);
    if (pair) {
      points.push({ label: pair[1]!.trim().slice(0, 16), value: Number(pair[2]) });
      continue;
    }
    // Bare numbers, possibly several in one chunk: "3 5 9".
    for (const bare of piece.split(/\s+/)) {
      if (!/^-?\d+(?:\.\d+)?$/.test(bare)) continue;
      points.push({ label: String(points.length + 1), value: Number(bare) });
    }
  }
  return points;
}

export const chart: Command = {
  name: 'chart',
  description: 'Draw numbers you paste, as a chart',
  usage: '/chart bar mon=3 tue=5 wed=9',

  async run(ctx) {
    let rest = ctx.args.trim();
    if (!rest) {
      await say(ctx, 'Usage: `/chart bar mon=3 tue=5 wed=9`. Kinds: ' + KINDS.join(', ') + '.');
      return;
    }

    // An optional leading kind, then the numbers.
    let kind: ChartKind = 'bar';
    const first = /^([a-z]+)\b/i.exec(rest);
    if (first && KINDS.includes(first[1]!.toLowerCase() as ChartKind)) {
      kind = first[1]!.toLowerCase() as ChartKind;
      rest = rest.slice(first[0].length).trim();
    }

    const points = parsePoints(rest);
    const cap = kind === 'pie' || kind === 'donut' ? 8 : 24;
    if (points.length < 2) {
      await say(ctx, 'I need at least two numbers. `/chart mon=3 tue=5`');
      return;
    }
    if (points.length > cap) {
      await say(ctx, `That is ${points.length} points; a ${kind} chart holds ${cap}.`);
      return;
    }

    // The numbers go in as fields as well as into the picture. A client that
    // cannot draw the chart still shows what it was about, and a chart nobody
    // can read is not information.
    const embed = card(`${kind} chart`);
    for (const point of points.slice(0, 12)) {
      embed.field(point.label, String(point.value), true);
    }
    embed.chart(kind, points);

    await ctx.bot.reply(ctx.conversationId, ctx.message.id, { embeds: [embed.build()] });
  },
};
