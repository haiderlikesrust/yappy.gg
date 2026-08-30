/**
 * Glyphs the space feature needs that the shared set does not carry yet.
 * Same visual voice as `ui/icons.tsx`: 24px grid, 1.8px strokes, round caps
 * and joins, `currentColor`. No emoji as chrome — house rule.
 */

import type { SVGProps } from 'react';

export type SpaceGlyphName = 'hash' | 'chevron-down' | 'unarchive';

const PATHS: Record<SpaceGlyphName, JSX.Element> = {
  /** The channel mark — a hand-drawn #. */
  hash: <path d="M9.8 4.5 8.2 19.5M15.8 4.5l-1.6 15M5 9.2h14.5M4.5 14.8H19" />,
  'chevron-down': <path d="m5.5 9.5 6.5 6.5 6.5-6.5" />,
  /** A box giving a conversation back: archive body, arrow climbing out. */
  unarchive: (
    <>
      <path d="M4.5 5.5h15V9h-15V5.5ZM6 9v9A1.5 1.5 0 0 0 7.5 19.5h9A1.5 1.5 0 0 0 18 18V9" />
      <path d="M12 16.5v-5m0 0-2.4 2.4M12 11.5l2.4 2.4" />
    </>
  ),
};

export function SpaceGlyph(
  props: { name: SpaceGlyphName; size?: number } & Omit<SVGProps<SVGSVGElement>, 'name'>,
) {
  const { name, size = 20, ...rest } = props;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}
