/**
 * Local glyphs missing from the shared set in ../icons.tsx, drawn in the same
 * visual voice (24px grid, 1.8 stroke, round caps, currentColor). Candidates
 * for promotion into the shared file by its owner.
 */

import type { ReactNode, SVGProps } from 'react';

function Glyph(
  props: { size?: number; children: ReactNode } & SVGProps<SVGSVGElement>,
) {
  const { size = 20, children, ...rest } = props;
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
      {children}
    </svg>
  );
}

/** Paperclip — non-image attachment rows. */
export function PaperclipIcon(props: { size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <Glyph {...props}>
      <path d="M16.5 11.5 10 18a3.5 3.5 0 0 1-5-5l7.8-7.8a2.5 2.5 0 0 1 3.5 3.5L8.5 16.5a1.4 1.4 0 0 1-2-2l6.3-6.3" />
    </Glyph>
  );
}

/** Microphone — the voice-note button. */
export function MicIcon(props: { size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <Glyph {...props}>
      <rect x="9" y="3.5" width="6" height="11" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" />
      <path d="M12 18v2.5" />
    </Glyph>
  );
}

/** Map pin — location cards. */
export function MapPinIcon(props: { size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <Glyph {...props}>
      <path d="M12 21s-6.5-5.6-6.5-10.5a6.5 6.5 0 0 1 13 0C18.5 15.4 12 21 12 21Z" />
      <circle cx="12" cy="10.5" r="2.3" />
    </Glyph>
  );
}

/** Play — audio player. Filled triangle reads better at 14px than a stroke. */
export function PlayIcon(props: { size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <Glyph {...props}>
      <path d="M8.5 5.8v12.4c0 .8.9 1.3 1.6.9l9-6.2a1.05 1.05 0 0 0 0-1.8l-9-6.2c-.7-.4-1.6.1-1.6.9Z" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

/** Pause — audio player. */
export function PauseIcon(props: { size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <Glyph {...props}>
      <rect x="7" y="5.5" width="3.4" height="13" rx="1.2" fill="currentColor" stroke="none" />
      <rect x="13.6" y="5.5" width="3.4" height="13" rx="1.2" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

/** Stop — ends a recording. */
export function StopIcon(props: { size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <Glyph {...props}>
      <rect x="6.5" y="6.5" width="11" height="11" rx="2.5" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

/** Clock — a send still in flight. */
export function ClockIcon(props: { size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <Glyph {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </Glyph>
  );
}

/**
 * The tick ladder on own messages: one tick = on the server, two = delivered
 * to someone else's device, accent pair = read. Drawn as one glyph so the
 * pair keeps its exact overlap at any size.
 */
export function TicksIcon(
  props: { size?: number; double?: boolean } & SVGProps<SVGSVGElement>,
) {
  const { double = false, ...rest } = props;
  return (
    <Glyph strokeWidth={2.1} {...rest}>
      {double ? (
        <>
          <path d="m2.5 12.8 4 4L15 8" />
          <path d="m11.5 15.6 1.2 1.2L21.5 8" />
        </>
      ) : (
        <path d="m5.5 12.8 4.2 4.2L18.5 8" />
      )}
    </Glyph>
  );
}
