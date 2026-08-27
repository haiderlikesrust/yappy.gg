/**
 * Local glyphs missing from the shared set in ../icons.tsx, drawn in the same
 * visual voice (24px grid, 1.8 stroke, round caps, currentColor). Candidates
 * for promotion into the shared file by its owner.
 */

import type { SVGProps } from 'react';

/** Paperclip — non-image attachment rows. */
export function PaperclipIcon(props: { size?: number } & SVGProps<SVGSVGElement>) {
  const { size = 20, ...rest } = props;
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
      <path d="M16.5 11.5 10 18a3.5 3.5 0 0 1-5-5l7.8-7.8a2.5 2.5 0 0 1 3.5 3.5L8.5 16.5a1.4 1.4 0 0 1-2-2l6.3-6.3" />
    </svg>
  );
}
