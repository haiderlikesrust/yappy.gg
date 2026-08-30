/**
 * Glyphs the bot directory needs that the shared set does not carry yet.
 * Same visual voice as ui/icons.tsx — 24px grid, 1.8 stroke, round caps,
 * currentColor — kept local per the file-ownership rules. Fold into icons.tsx
 * whenever its owner takes them.
 */

import type { SVGProps } from 'react';

export type BotIconName = 'bot' | 'slash';

const PATHS: Record<BotIconName, JSX.Element> = {
  bot: (
    <>
      <rect x="5" y="8.5" width="14" height="10" rx="3" />
      <path d="M12 8.5V5.5M12 5.5a1.3 1.3 0 1 0-.01 0Z" />
      <path d="M9.3 13h.01M14.7 13h.01" strokeWidth="2.4" />
      <path d="M9.5 15.8c.7.6 1.5.9 2.5.9s1.8-.3 2.5-.9" />
    </>
  ),
  slash: <path d="m14.5 4.5-5 15" />,
};

export function BotIcon(
  props: { name: BotIconName; size?: number } & Omit<SVGProps<SVGSVGElement>, 'name'>,
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
