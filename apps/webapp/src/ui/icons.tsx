/**
 * The icon set. Hand-drawn SVG paths, one visual voice: 24px grid, 1.8px
 * strokes, round caps and joins, `currentColor` throughout so they inherit
 * text color. No emoji anywhere in the chrome — that is a design-language
 * rule, not a preference. If a glyph is missing, add it here in the same
 * style rather than reaching for a character.
 */

import type { SVGProps } from 'react';

export type IconName =
  | 'chat'
  | 'compass'
  | 'user'
  | 'users'
  | 'send'
  | 'plus'
  | 'search'
  | 'pin'
  | 'reply'
  | 'edit'
  | 'trash'
  | 'copy'
  | 'close'
  | 'check'
  | 'smile'
  | 'gif'
  | 'sticker'
  | 'image'
  | 'settings'
  | 'bell'
  | 'sparkle'
  | 'paw'
  | 'chart'
  | 'download'
  | 'arrow-down'
  | 'arrow-right'
  | 'chevron-left'
  | 'chevron-right'
  | 'link'
  | 'logout'
  | 'shield'
  | 'lock'
  | 'crown'
  | 'dots'
  | 'megaphone'
  | 'gift'
  | 'bookmark'
  | 'globe'
  | 'volume'
  | 'mic'
  | 'mic-off'
  | 'file';

const PATHS: Record<IconName, JSX.Element> = {
  file: (
    <>
      <path d="M13.5 3.5H7.5A2 2 0 0 0 5.5 5.5v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8.5l-5-5Z" />
      <path d="M13.5 3.5v5h5" />
      <path d="M9 13.5h6M9 17h4" />
    </>
  ),
  chat: (
    <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H12l-4.2 3.2c-.5.4-1.3 0-1.3-.7V17h-.5A2.5 2.5 0 0 1 4 14.5v-8Z" />
  ),
  compass: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m14.8 9.2-1.6 4-4 1.6 1.6-4 4-1.6Z" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5.5 19.5c1-3.2 3.5-4.8 6.5-4.8s5.5 1.6 6.5 4.8" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="9" r="3" />
      <path d="M3.5 19c.8-2.7 2.9-4 5.5-4s4.7 1.3 5.5 4" />
      <path d="M15.5 6.7a3 3 0 1 1 1.2 5.8M17.5 15.3c1.7.5 2.7 1.7 3.2 3.7" />
    </>
  ),
  send: <path d="M4.5 12 19 5.5c.6-.3 1.1.3.9.9l-5.6 13.4c-.3.6-1.1.6-1.4 0l-2-4.9a1 1 0 0 0-.5-.5l-4.9-2c-.6-.3-.6-1.1 0-1.4Z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m19.5 19.5-3.8-3.8" />
    </>
  ),
  pin: <path d="M9 4h6l-.6 6.2 2.6 2.8v1.5H7v-1.5l2.6-2.8L9 4ZM12 14.5V20" />,
  reply: <path d="M9.5 7 4.5 11.5 9.5 16M5 11.5h9a5 5 0 0 1 5 5V18" />,
  edit: <path d="M14.5 5.5 18.5 9.5 8.5 19.5H4.5V15.5L14.5 5.5ZM12.5 7.5l4 4" />,
  trash: (
    <path d="M5 7h14M10 7V5.5A1.5 1.5 0 0 1 11.5 4h1A1.5 1.5 0 0 1 14 5.5V7m3.5 0-.8 11.2A2 2 0 0 1 14.7 20H9.3a2 2 0 0 1-2-1.8L6.5 7M10 11v5M14 11v5" />
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5.5 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v.5" />
    </>
  ),
  close: <path d="m6 6 12 12M18 6 6 18" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  smile: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.8 14c.8 1.2 1.9 1.8 3.2 1.8s2.4-.6 3.2-1.8" />
      <path d="M9.3 9.8h.01M14.7 9.8h.01" strokeWidth="2.4" />
    </>
  ),
  gif: (
    <>
      <rect x="3" y="5.5" width="18" height="13" rx="2.5" />
      <path d="M9.5 10.2a2 2 0 0 0-3.5 1.3v1a2 2 0 0 0 3.5 1.3v-1.3h-1M12.5 9.8v4.4M15 14.2V9.8h3M15 12h2.3" />
    </>
  ),
  sticker: (
    <path d="M5 7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v6l-6 6H7a2 2 0 0 1-2-2V7ZM13 19v-4a2 2 0 0 1 2-2h4" />
  ),
  image: (
    <>
      <rect x="4" y="5" width="16" height="14" rx="2.5" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="m6 17 4.5-4.5 3 3 2-2L19 17" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 4.5v2M12 17.5v2M19.5 12h-2M6.5 12h-2M17.3 6.7l-1.4 1.4M8.1 15.9l-1.4 1.4M17.3 17.3l-1.4-1.4M8.1 8.1 6.7 6.7" />
    </>
  ),
  bell: (
    <path d="M6.5 15.5V11a5.5 5.5 0 1 1 11 0v4.5l1.5 2v1H5v-1l1.5-2ZM10.5 20a1.8 1.8 0 0 0 3 0" />
  ),
  sparkle: (
    <path d="M12 4c.6 3.4 2 4.8 5.5 5.5C14 10.2 12.6 11.6 12 15c-.6-3.4-2-4.8-5.5-5.5C10 8.8 11.4 7.4 12 4ZM18 15c.3 1.7 1 2.4 2.5 2.7-1.5.3-2.2 1-2.5 2.7-.3-1.7-1-2.4-2.5-2.7 1.5-.3 2.2-1 2.5-2.7Z" />
  ),
  paw: (
    <>
      <circle cx="8" cy="8.4" r="1.7" />
      <circle cx="16" cy="8.4" r="1.7" />
      <circle cx="4.9" cy="12.2" r="1.5" />
      <circle cx="19.1" cy="12.2" r="1.5" />
      <path d="M12 12.2c2.6 0 4.8 2 4.8 4.2 0 1.6-1.2 2.6-2.6 2.6-.9 0-1.5-.4-2.2-.4s-1.3.4-2.2.4c-1.4 0-2.6-1-2.6-2.6 0-2.2 2.2-4.2 4.8-4.2Z" />
    </>
  ),
  chart: <path d="M4.5 19.5v-15M4.5 19.5h15M8.5 15.5v-5M12.5 15.5V8M16.5 15.5v-3.5" />,
  download: <path d="M12 4.5v10m0 0 4-4m-4 4-4-4M5 19.5h14" />,
  'arrow-down': <path d="M12 5v13m0 0 5.5-5.5M12 18l-5.5-5.5" />,
  'arrow-right': <path d="M5 12h13m0 0-5.5-5.5M18 12l-5.5 5.5" />,
  'chevron-left': <path d="M14.5 5.5 8 12l6.5 6.5" />,
  'chevron-right': <path d="m9.5 5.5 6.5 6.5-6.5 6.5" />,
  link: (
    <path d="M10 14.5 14 10.5M8.5 12l-2.3 2.3a3.5 3.5 0 0 0 5 5L13.5 17M15.5 12l2.3-2.3a3.5 3.5 0 0 0-5-5L10.5 7" />
  ),
  logout: <path d="M14 6.5V5a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 5v14A1.5 1.5 0 0 0 6 20.5h6.5A1.5 1.5 0 0 0 14 19v-1.5M9.5 12h10m0 0-3.5-3.5M19.5 12 16 15.5" />,
  shield: <path d="M12 3.5 5 6v5.5c0 4.4 2.9 7.4 7 9 4.1-1.6 7-4.6 7-9V6l-7-2.5ZM9 12l2.2 2.2L15.5 9.5" />,
  lock: <path d="M6.5 10.5h11a1 1 0 0 1 1 1V19a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-7.5a1 1 0 0 1 1-1ZM8.5 10.5V7.8a3.5 3.5 0 0 1 7 0v2.7M12 14.2v2.3" />,
  crown: <path d="M4.5 8.5 8 11l4-5 4 5 3.5-2.5-1.5 9h-12l-1.5-9Z" />,
  dots: (
    <path d="M6 12h.01M12 12h.01M18 12h.01" strokeWidth="2.6" />
  ),
  megaphone: <path d="M4 10.5v3a1.5 1.5 0 0 0 1.5 1.5H7l6 4V5l-6 4H5.5A1.5 1.5 0 0 0 4 10.5ZM16.5 9.5a4 4 0 0 1 0 5M9 15.5l1 4.5" />,
  gift: (
    <>
      <rect x="4" y="9" width="16" height="4" rx="1" />
      <path d="M6 13v6a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 19v-6M12 9v11.5M12 9c-1.8 0-4-.7-4-2.5C8 4.6 10.6 4.9 12 9ZM12 9c1.8 0 4-.7 4-2.5C16 4.6 13.4 4.9 12 9Z" />
    </>
  ),
  bookmark: (
    <path d="M7 4.5h10A1.5 1.5 0 0 1 18.5 6v13.4a.6.6 0 0 1-.94.5L12 15.9l-5.56 4a.6.6 0 0 1-.94-.5V6A1.5 1.5 0 0 1 7 4.5Z" />
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.55 2.3 3.85 5.15 3.85 8.5S14.55 18.2 12 20.5c-2.55-2.3-3.85-5.15-3.85-8.5S9.45 5.8 12 3.5Z" />
    </>
  ),
  volume: (
    <path d="M4.5 10v4a1 1 0 0 0 1 1h2.3l4.2 3.4a.6.6 0 0 0 1-.47V6.07a.6.6 0 0 0-1-.47L7.8 9H5.5a1 1 0 0 0-1 1ZM15.6 9.3a3.8 3.8 0 0 1 0 5.4M18.1 6.8a7.3 7.3 0 0 1 0 10.4" />
  ),
  mic: (
    <>
      <rect x="9" y="3.5" width="6" height="11" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5" />
    </>
  ),
  'mic-off': (
    <>
      <path d="M9 9v2.5a3 3 0 0 0 4.8 2.4M15 11.2V6.5a3 3 0 0 0-5.6-1.5" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 10.6 5M18.5 11.5a6.5 6.5 0 0 1-.86 3.24M12 18v2.5" />
      <path d="M4.5 4.5l15 15" />
    </>
  ),
};

export function Icon(
  props: { name: IconName; size?: number } & Omit<SVGProps<SVGSVGElement>, 'name'>,
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
