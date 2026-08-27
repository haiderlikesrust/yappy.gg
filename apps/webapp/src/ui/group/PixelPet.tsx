import { useEffect, useRef } from 'react';
import type { GroupPet } from '../../lib/types';
import './group.css';

/**
 * The group pet: a pixel creature, drawn from character grids, animated by
 * flipping between two frames the way a Tamagotchi did.
 *
 * A faithful port of android/.../ui/components/PixelPet.kt (the canonical
 * implementation) — the grids are copied verbatim, and species/colour are
 * derived with Java's exact `String.hashCode()` so the same group shows the
 * same creature here as on the phones. The vocabulary:
 *
 *   .  transparent      o  outline          b  body (identity colour)
 *   B  body shade       w  white            p  pink (tongue, inner ear)
 *   e  eye              y  brand yellow (sparkles, crown)
 */

export type PetSpecies = 'dog' | 'cat';

/**
 * Kotlin/Java `String.hashCode()`: h = 31·h + c over UTF-16 code units with
 * 32-bit signed overflow wrapping. Parity with the phones requires this exact
 * arithmetic — `Math.imul` gives the wrap, `| 0` keeps every step in Int32.
 */
export function javaHashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h;
}

export function petSpecies(conversationId: string): PetSpecies {
  return (javaHashCode(conversationId) & 1) === 0 ? 'dog' : 'cat';
}

/** Same fallback palette as android Avatar.kt — deterministic per id. */
const FALLBACK_COLORS = [
  '#6C5CE7',
  '#00B894',
  '#E17055',
  '#0984E3',
  '#D63031',
  '#6D4C41',
  '#00838F',
  '#8E24AA',
] as const;

export function colorForId(id: string): string {
  // Math.abs on the Int32 hash matches Kotlin's absoluteValue for every value
  // including MIN_VALUE (both land on index 0 after % 8).
  return FALLBACK_COLORS[Math.abs(javaHashCode(id)) % FALLBACK_COLORS.length]!;
}

/** The 0.72 shade variant the phones use for the body's darker pixels. */
function shadeOf(hex: string): string {
  const r = Math.round(parseInt(hex.slice(1, 3), 16) * 0.72);
  const g = Math.round(parseInt(hex.slice(3, 5), 16) * 0.72);
  const b = Math.round(parseInt(hex.slice(5, 7), 16) * 0.72);
  return `rgb(${r},${g},${b})`;
}

// ─── Sprites (verbatim from PixelPet.kt) ─────────────────────────────────────

const EGG: string[][] = [
  [
    '................',
    '................',
    '......oooo......',
    '.....obbbbo.....',
    '....obbwbbbo....',
    '...obbwbbbbbo...',
    '...obbbbbbbbo...',
    '..obbbbbbbbbbo..',
    '..obbBbbbbBbbo..',
    '..obbbbbbbbbbo..',
    '..obBbbbbbbBbo..',
    '...obbbbbbbbo...',
    '....oobbbboo....',
    '......oooo......',
    '................',
    '................',
  ],
  [
    '................',
    '................',
    '................',
    '......oooo......',
    '.....obbbbo.....',
    '....obbwbbbo....',
    '...obbwbbbbbo...',
    '...obbbbbbbbo...',
    '..obbbbbbbbbbo..',
    '..obbBbbbbBbbo..',
    '..obbbbbbbbbbo..',
    '..obBbbbbbbBbo..',
    '...obbbbbbbbo...',
    '.....oooooo.....',
    '................',
    '................',
  ],
];

// Dog: floppy ears, big muzzle. Frame two lifts the ears and wags.
function dogFrames(mood: string): string[][] {
  // Rows 10-11 are the mouth region, swapped per mood.
  const body = (earUp: boolean, mouthA: string, mouthB: string): string[] => {
    const e1 = earUp ? '..oo........oo..' : '................';
    const e2 = earUp ? '.obbo......obbo.' : '..oo........oo..';
    const e3 = earUp ? '.obBbo....obBbo.' : '.obbo......obbo.';
    return [
      '................',
      e1,
      e2,
      e3,
      '.obBbooooooBbbo.',
      '.obbobbbbbbobbo.',
      '..oobbbbbbbboo..',
      '..obbebbbbebbo..',
      '..obbbbbbbbbbo..',
      '..obbbBooBbbbo..',
      mouthA,
      mouthB,
      '...obbbbbbbbo...',
      '....oooooooo....',
      '................',
      '................',
    ];
  };
  switch (mood) {
    case 'happy':
      return [
        body(false, '..obbboppobbbo..', '...obbboppbbo...'),
        body(true, '..obbboppobbbo..', '...obbbbppbo....'),
      ];
    case 'hungry':
      return [
        body(false, '..obbbboobbbbo..', '...obbbbbbbbo...'),
        body(false, '..obbboooobbbo..', '...obbbbbbbbo...'),
      ];
    default: // sad
      return [
        body(false, '..obbbboobbbbo..', '...obbboobbbo...'),
        body(false, '..obbbboobbbbo..', '...obbboobbbo...'),
      ];
  }
}

// Cat: pointed ears, small mouth. Frame two flicks an ear and the tail.
function catFrames(mood: string): string[][] {
  const body = (flick: boolean, mouthA: string, mouthB: string): string[] => {
    const e1 = flick ? '..o..........o..' : '..o.........o...';
    const e2 = '..opo......opo..';
    return [
      '................',
      e1,
      e2,
      '..obpo....obpo..',
      '..obboooooobbo..',
      '.obbbbbbbbbbbbo.',
      '.obebbbbbbbebbo.',
      '.obbbbbbbbbbbbo.',
      '..obbBwbbwBbbo..',
      mouthA,
      mouthB,
      '..obbbbbbbbbbo..',
      '...obbbbbbbbo...',
      '....oooooooo....',
      '................',
      '................',
    ];
  };
  switch (mood) {
    case 'happy':
      return [
        body(false, '..obbbopbobbbo..', '...obbbbbbbbo...'),
        body(true, '..obbbobpobbbo..', '...obbbbbbbbo...'),
      ];
    case 'hungry':
      return [
        body(false, '..obbbboobbbbo..', '...obbbbbbbbo...'),
        body(true, '..obbbboobbbbo..', '...obbbbbbbbo...'),
      ];
    default: // sad
      return [
        body(false, '..obbboBBobbbo..', '...obbbbbbbbo...'),
        body(false, '..obbboBBobbbo..', '...obbbbbbbbo...'),
      ];
  }
}

// Wandered off: an empty spot — footprints trailing away and a question.
const GONE: string[][] = [
  [
    '................',
    '......ww........',
    '.....w..w.......',
    '........w.......',
    '.......w........',
    '.......w........',
    '................',
    '.......w........',
    '................',
    '..BB............',
    '..BB....BB......',
    '........BB......',
    '............BB..',
    '............BB..',
    '................',
    '................',
  ],
];

// Elder crown, drawn over the sprite's head rows.
const CROWN: string[] = ['....y..y..y.....', '....yyyyyy......'];

// ─── Rendering ───────────────────────────────────────────────────────────────

const OUTLINE = '#1A1721';
const WHITE = '#F2F0F8';
const PINK = '#FF8FA3';
const EYE = '#17151F';
const YELLOW = '#FCCE09';

/**
 * @param conversationId decides species and the body colour.
 * @param pet the server's pet state — `stage` (egg | baby | kid | grown |
 *   elder) picks size and form, `mood` (happy | hungry | sad | gone) picks
 *   expression and tempo.
 * @param size rendered box in CSS px; works from 22 (chip) to ~96 (card).
 * @param animated pass false to freeze on frame one (also honoured
 *   automatically when the user prefers reduced motion).
 */
export function PixelPet(props: {
  conversationId: string;
  pet: GroupPet;
  size: number;
  animated?: boolean;
}) {
  const { conversationId, size } = props;
  const stage = props.pet.stage;
  const mood = props.pet.mood;
  const animated = props.animated ?? true;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const px = Math.round(size * dpr);
    canvas.width = px;
    canvas.height = px;

    const body = colorForId(conversationId);
    const shade = shadeOf(body);
    const species = petSpecies(conversationId);

    const frames =
      mood === 'gone'
        ? GONE
        : stage === 'egg'
          ? EGG
          : species === 'dog'
            ? dogFrames(mood)
            : catFrames(mood);

    // Sad pets breathe slowly; happy ones can barely sit still.
    const periodMs = mood === 'happy' ? 380 : mood === 'hungry' ? 650 : 900;

    // Babies are the same creature, smaller in the same box.
    const scale = stage === 'baby' ? 0.72 : stage === 'kid' ? 0.88 : 1;

    const colorFor = (ch: string): string | null => {
      switch (ch) {
        case 'o':
          return OUTLINE;
        case 'b':
          return body;
        case 'B':
          return shade;
        case 'w':
          return WHITE;
        case 'p':
          return PINK;
        case 'e':
          return EYE;
        case 'y':
          return YELLOW;
        default:
          return null;
      }
    };

    const cells = 16;
    const cell = (px / cells) * scale;
    const originX = (px - cell * cells) / 2;

    const drawGrid = (rows: string[], originY: number, yOffsetRows = 0): void => {
      for (let y = 0; y < rows.length; y += 1) {
        const row = rows[y]!;
        for (let x = 0; x < row.length; x += 1) {
          const color = colorFor(row[x]!);
          if (!color) continue;
          ctx.fillStyle = color;
          // +0.5 overdraw kills the hairline seams between cells, same as the
          // Compose implementation.
          ctx.fillRect(originX + x * cell, originY + (y + yOffsetRows) * cell, cell + 0.5, cell + 0.5);
        }
      }
    };

    const draw = (frame: number, bob: number): void => {
      ctx.clearRect(0, 0, px, px);
      const originY = (px - cell * cells) / 2 + bob * cell * 0.5;
      drawGrid(frames[frame] ?? frames[0]!, originY);
      if (stage === 'elder' && mood !== 'gone') drawGrid(CROWN, originY, -1);
    };

    const reduceMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (!animated || reduceMotion || frames.length < 2) {
      draw(0, 0);
      return;
    }

    let raf = 0;
    let lastFrame = -1;
    let lastBob = -1;
    const start = performance.now();
    const tick = (now: number): void => {
      // phase runs 0→2 over two periods, matching the Compose transition.
      const phase = ((now - start) % (periodMs * 2)) / periodMs;
      const frame = phase >= 1 ? 1 : 0;
      // A gentle bob for the happy ones, half a pixel of life.
      const bob = mood === 'happy' && stage !== 'egg' ? Math.abs(phase - 1) : 0;
      if (frame !== lastFrame || Math.abs(bob - lastBob) * cell > 0.35) {
        draw(frame, bob);
        lastFrame = frame;
        lastBob = bob;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [conversationId, stage, mood, size, animated]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: size, height: size, imageRendering: 'pixelated' }}
      aria-hidden
    />
  );
}
