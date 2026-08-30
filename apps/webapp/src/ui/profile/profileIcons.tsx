/**
 * Glyphs the profile card needs that the shared set does not carry yet.
 * Same visual voice as ui/icons.tsx — 24px grid, 1.8 stroke, round caps,
 * currentColor — kept local per the file-ownership rules. Fold into icons.tsx
 * whenever its owner takes them.
 */

import type { SVGProps } from 'react';

export type ProfileIconName = 'user-plus' | 'user-check' | 'flag' | 'ban';

const PATHS: Record<ProfileIconName, JSX.Element> = {
  'user-plus': (
    <>
      <circle cx="10" cy="8.5" r="3.5" />
      <path d="M4 19.5c.9-3.1 3.2-4.7 6-4.7 1.4 0 2.7.4 3.7 1.2" />
      <path d="M18 13.5v6M15 16.5h6" />
    </>
  ),
  'user-check': (
    <>
      <circle cx="10" cy="8.5" r="3.5" />
      <path d="M4 19.5c.9-3.1 3.2-4.7 6-4.7 1.4 0 2.7.4 3.7 1.2" />
      <path d="m15 16.5 2.2 2.2 3.8-4.4" />
    </>
  ),
  flag: <path d="M6 21V4.5M6 5c1.5-1 3-1.3 4.5-.7 1.8.7 3.4.8 5.5-.3l1 8c-2.1 1.1-3.7 1-5.5.3C10 11.7 7.5 12 6 13" />,
  ban: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M6 6l12 12" />
    </>
  ),
};

export function ProfileIcon(
  props: { name: ProfileIconName; size?: number } & Omit<SVGProps<SVGSVGElement>, 'name'>,
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
