/**
 * Blurhash placeholders for image attachments.
 *
 * The decode is the standard algorithm (https://blurha.sh) implemented inline
 * — ~60 lines is cheaper than a dependency. Decoded once per hash to a tiny
 * canvas dataURL and cached; the real image fades in over it on load, and the
 * wrapper reserves the attachment's aspect ratio so the timeline never jumps.
 */

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useAuthedMedia } from '../../lib/authedMedia';
import type { Attachment } from '../../lib/types';

// ── Decode ───────────────────────────────────────────────────────────────────

const B83 =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~';

function decode83(str: string): number {
  let value = 0;
  for (const c of str) value = value * 83 + B83.indexOf(c);
  return value;
}

function sRGBToLinear(value: number): number {
  const v = value / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function linearTosRGB(value: number): number {
  const v = Math.max(0, Math.min(1, value));
  return v <= 0.0031308
    ? Math.round(v * 12.92 * 255 + 0.5)
    : Math.round((1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255 + 0.5);
}

function signPow(value: number, exp: number): number {
  return Math.sign(value) * Math.pow(Math.abs(value), exp);
}

function decodePixels(hash: string, width: number, height: number): Uint8ClampedArray | null {
  if (hash.length < 6) return null;
  const sizeFlag = decode83(hash[0]!);
  const numY = Math.floor(sizeFlag / 9) + 1;
  const numX = (sizeFlag % 9) + 1;
  if (hash.length !== 4 + 2 * numX * numY) return null;

  const maxValue = (decode83(hash[1]!) + 1) / 166;

  const colors: Array<[number, number, number]> = [];
  const dc = decode83(hash.substring(2, 6));
  colors.push([sRGBToLinear(dc >> 16), sRGBToLinear((dc >> 8) & 255), sRGBToLinear(dc & 255)]);
  for (let i = 1; i < numX * numY; i += 1) {
    const value = decode83(hash.substring(4 + i * 2, 6 + i * 2));
    colors.push([
      signPow((Math.floor(value / (19 * 19)) - 9) / 9, 2) * maxValue,
      signPow((Math.floor(value / 19) % 19 - 9) / 9, 2) * maxValue,
      signPow(((value % 19) - 9) / 9, 2) * maxValue,
    ]);
  }

  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let j = 0; j < numY; j += 1) {
        const basisY = Math.cos((Math.PI * y * j) / height);
        for (let i = 0; i < numX; i += 1) {
          const basis = Math.cos((Math.PI * x * i) / width) * basisY;
          const color = colors[i + j * numX]!;
          r += color[0] * basis;
          g += color[1] * basis;
          b += color[2] * basis;
        }
      }
      const at = 4 * (x + y * width);
      pixels[at] = linearTosRGB(r);
      pixels[at + 1] = linearTosRGB(g);
      pixels[at + 2] = linearTosRGB(b);
      pixels[at + 3] = 255;
    }
  }
  return pixels;
}

const dataUrlCache = new Map<string, string | null>();

/** Blurhash → 32px dataURL, memoised per hash. Null when the hash is bad. */
export function blurhashToDataUrl(hash: string): string | null {
  const cached = dataUrlCache.get(hash);
  if (cached !== undefined) return cached;
  let url: string | null = null;
  try {
    const w = 32;
    const h = 32;
    const pixels = decodePixels(hash, w, h);
    if (pixels) {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        // createImageData + set, rather than `new ImageData(pixels, …)` — the
        // constructor overloads are picky about the backing buffer's type.
        const imageData = ctx.createImageData(w, h);
        imageData.data.set(pixels);
        ctx.putImageData(imageData, 0, 0);
        url = canvas.toDataURL();
      }
    }
  } catch {
    url = null;
  }
  dataUrlCache.set(hash, url);
  return url;
}

// ── Component ────────────────────────────────────────────────────────────────

/** The serializer sends these on every attachment; the shared client type has
 *  not caught up yet, so widen locally. */
export type AttachmentWire = Attachment & {
  blurhash?: string | null;
  waveform?: number[] | null;
  durationMs?: number | null;
};

/**
 * An image attachment with a blurhash placeholder underneath. The wrapper
 * takes the attachment's aspect ratio up front so the row's height is right
 * before a single byte of the image arrives.
 */
export function BlurImage(props: { attachment: AttachmentWire; onClick?: () => void }) {
  const { attachment: a } = props;
  const [loaded, setLoaded] = useState(false);
  // Private-bucket images need the token an <img> cannot send; the hook
  // resolves them to blob URLs (public/external URLs pass straight through).
  const realSrc = useAuthedMedia(a.thumbnailUrl ?? a.url);
  const placeholder = useMemo(
    () => (a.blurhash ? blurhashToDataUrl(a.blurhash) : null),
    [a.blurhash],
  );

  // A cached image can fire onLoad before the effect ties — belt and braces.
  useEffect(() => setLoaded(false), [a.id]);

  const hasDims = Boolean(a.width && a.height);
  const style: CSSProperties = hasDims
    ? { aspectRatio: `${a.width} / ${a.height}`, width: Math.min(a.width!, 380) }
    : {};

  return (
    <button className="msg-attachment blur-wrap" style={style} onClick={props.onClick}>
      {placeholder && !loaded && (
        <img className="blur-under" src={placeholder} alt="" aria-hidden draggable={false} />
      )}
      <img
        className={`blur-real${loaded ? ' loaded' : ''}`}
        src={realSrc ?? undefined}
        alt={a.filename ?? ''}
        loading="lazy"
        onLoad={() => setLoaded(true)}
      />
    </button>
  );
}
