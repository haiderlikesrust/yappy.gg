/**
 * Glyphs the shared set (../icons.tsx) does not have yet, drawn in the same
 * voice: 24px grid, 1.8 stroke, currentColor, round caps. Local to the media
 * layer on purpose — icons.tsx is owned elsewhere in this push.
 */

import type { SVGProps } from 'react';

type LocalIconName = 'retry' | 'file' | 'clock' | 'heart';

const PATHS: Record<LocalIconName, JSX.Element> = {
  retry: (
    <>
      <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
      <path d="M19.5 3.5v3.4h-3.4" />
    </>
  ),
  file: (
    <>
      <path d="M6 4.5A1.5 1.5 0 0 1 7.5 3H14l4 4v12.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19.5v-15Z" />
      <path d="M14 3v4h4" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  heart: (
    <path d="M12 20s-7.5-4.6-7.5-9.8A4.2 4.2 0 0 1 8.7 6c1.4 0 2.6.7 3.3 1.8A3.9 3.9 0 0 1 15.3 6a4.2 4.2 0 0 1 4.2 4.2C19.5 15.4 12 20 12 20Z" />
  ),
};

export function MediaIcon(
  props: { name: LocalIconName; size?: number } & Omit<SVGProps<SVGSVGElement>, 'name'>,
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
