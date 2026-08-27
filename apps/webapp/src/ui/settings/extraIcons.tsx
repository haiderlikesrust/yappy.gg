/**
 * Glyphs the release notes need that the shared set does not carry yet.
 * Same visual voice as ui/icons.tsx — 24px grid, 1.8 stroke, round caps,
 * currentColor — kept local per the file-ownership rules. Fold into icons.tsx
 * whenever its owner takes them.
 */

import type { SVGProps } from 'react';

export type ExtraIconName = 'bolt' | 'bug' | 'phone';

const PATHS: Record<ExtraIconName, JSX.Element> = {
  bolt: <path d="M13 3 5.5 13.5H11L10 21l7.5-10.5H12L13 3Z" />,
  bug: (
    <>
      <ellipse cx="12" cy="13.5" rx="5" ry="6" />
      <path d="M9.5 8.5c0-1.9 1.1-3 2.5-3s2.5 1.1 2.5 3M12 9.5v10M4.5 13.5H7m10 0h2.5M5.5 8.5 8 10.2m10.5-1.7L16 10.2M5.5 19 8 17m10.5 2L16 17" />
    </>
  ),
  phone: (
    <path d="M7.2 4h2.1c.5 0 .9.3 1 .8l.7 2.8c.1.4 0 .9-.4 1.1l-1.4 1a12.3 12.3 0 0 0 5.1 5.1l1-1.4c.2-.4.7-.5 1.1-.4l2.8.7c.5.1.8.5.8 1v2.1c0 1.2-1 2.2-2.2 2.1C10.5 18.4 5.6 13.5 5.1 6.2 5 5 6 4 7.2 4Z" />
  ),
};

export function ExtraIcon(
  props: { name: ExtraIconName; size?: number } & Omit<SVGProps<SVGSVGElement>, 'name'>,
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
