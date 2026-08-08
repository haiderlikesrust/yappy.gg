/**
 * Turn the supplied brand artwork into the assets Android needs.
 *
 *   node tools/make-brand-assets.mjs <icon.png>
 *
 * The source is a flat white mark on a flat colour. Everything downstream wants
 * that mark as a *silhouette* — an alpha channel with no colour of its own — so
 * it can be tinted per theme, drawn white in the status bar, and re-coloured
 * for Android 13 themed icons without keeping four copies of the same drawing.
 *
 * Written against Node's built-in zlib rather than an image library on purpose:
 * this runs once when the artwork changes, and adding a native dependency to
 * the repo for it would cost more than the eighty lines below.
 *
 * Outputs (all white-on-transparent):
 *   res/drawable-nodpi/logo_mark.png        cropped to the mark, for in-app use
 *   res/mipmap-nodpi/ic_launcher_fg.png     padded into the adaptive safe zone
 */
import { deflateSync, inflateSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// ─── PNG ─────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** Decode an 8-bit, non-interlaced PNG to {width, height, rgba}. */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');

  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf[24];
  const colorType = buf[25];
  const interlace = buf[28];
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
  if (interlace !== 0) throw new Error('interlaced PNGs are not supported');

  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported colour type ${colorType}`);

  const idat = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + len));
    if (type === 'IEND') break;
    off += 12 + len;
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  let p = 0;

  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const line = Buffer.from(raw.subarray(p, p + stride));
    p += stride;

    // Undo the per-scanline filter. `channels` is the byte distance to the
    // pixel on the left, which is what every filter but None reaches back to.
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      switch (filter) {
        case 1: line[i] = (line[i] + a) & 0xff; break;
        case 2: line[i] = (line[i] + b) & 0xff; break;
        case 3: line[i] = (line[i] + ((a + b) >> 1)) & 0xff; break;
        case 4: line[i] = (line[i] + paeth(a, b, c)) & 0xff; break;
        default: break;
      }
    }

    for (let x = 0; x < width; x++) {
      const s = x * channels;
      const d = (y * width + x) * 4;
      if (channels >= 3) {
        out[d] = line[s];
        out[d + 1] = line[s + 1];
        out[d + 2] = line[s + 2];
        out[d + 3] = channels === 4 ? line[s + 3] : 255;
      } else {
        out[d] = out[d + 1] = out[d + 2] = line[s];
        out[d + 3] = channels === 2 ? line[s + 1] : 255;
      }
    }
    prev = line;
  }

  return { width, height, rgba: out };
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  // Filter 0 (None) throughout: the payload is mostly transparent runs, which
  // deflate handles well on its own, and it keeps this function short.
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ─── Silhouette ──────────────────────────────────────────────────────────────

const src = process.argv[2];
if (!src) {
  console.error('usage: node tools/make-brand-assets.mjs <icon.png>');
  process.exit(1);
}

const { width, height, rgba } = decodePng(readFileSync(src));

/**
 * The mark is white on a saturated flat colour, so distance from the background
 * colour separates them cleanly — and, importantly, *smoothly*: the in-between
 * values along an antialiased edge become partial alpha instead of a hard
 * staircase. Keying on one channel would fall apart on a background that
 * happened to be light.
 */
const bg = [rgba[0], rgba[1], rgba[2]];
console.log(`background  rgb(${bg.join(', ')})`);

const maxDist = Math.hypot(255 - bg[0], 255 - bg[1], 255 - bg[2]);
if (maxDist < 60) throw new Error('background is too close to white to key out');

const alpha = new Float32Array(width * height);
for (let i = 0; i < width * height; i++) {
  const d = Math.hypot(rgba[i * 4] - bg[0], rgba[i * 4 + 1] - bg[1], rgba[i * 4 + 2] - bg[2]);
  alpha[i] = Math.min(1, d / maxDist);
}

// Content bounds, ignoring the faint tail of the antialiasing so the crop is
// tight to the drawing rather than to its halo.
let minX = width, minY = height, maxX = -1, maxY = -1;
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    if (alpha[y * width + x] > 0.35) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
}
console.log(`mark bounds ${minX},${minY} → ${maxX},${maxY} (${maxX - minX + 1}×${maxY - minY + 1})`);

/** White pixels, alpha from the mask, sampled from `alpha` with an offset. */
const render = (w, h, sample) => {
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = sample(x, y);
      const d = (y * w + x) * 4;
      out[d] = out[d + 1] = out[d + 2] = 255;
      out[d + 3] = Math.round(Math.max(0, Math.min(1, a)) * 255);
    }
  }
  return out;
};

/** Bilinear, so scaling the mark down does not shred its thin strokes. */
const sampleAt = (fx, fy) => {
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const at = (x, y) =>
    x < 0 || y < 0 || x >= width || y >= height ? 0 : alpha[y * width + x];
  return (
    at(x0, y0) * (1 - tx) * (1 - ty) +
    at(x0 + 1, y0) * tx * (1 - ty) +
    at(x0, y0 + 1) * (1 - tx) * ty +
    at(x0 + 1, y0 + 1) * tx * ty
  );
};

const res = resolve(dirname(new URL(import.meta.url).pathname.slice(1)), '../app/src/main/res');
const write = (rel, buf) => {
  const path = resolve(res, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buf);
  console.log(`wrote ${rel}  ${(buf.length / 1024).toFixed(1)} KB`);
};

// 1. The mark itself, cropped with a hair of breathing room. Used wherever the
//    logo appears inside the app, always tinted.
{
  const pad = Math.round(Math.max(maxX - minX, maxY - minY) * 0.04);
  const w = maxX - minX + 1 + pad * 2;
  const h = maxY - minY + 1 + pad * 2;
  write('drawable-nodpi/logo_mark.png', encodePng(w, h, render(w, h, (x, y) => sampleAt(minX - pad + x, minY - pad + y))));
}

// 2. The launcher foreground. An adaptive icon is 108 units square but only the
//    middle 72 are guaranteed visible — the rest is what the launcher crops
//    into a circle, squircle or whatever the device prefers. So the mark is
//    scaled to sit inside that safe zone rather than trusting the source
//    artwork's own margins.
{
  const size = 432;
  /**
   * The safe zone is 72 of 108 units, but that is the largest *square* that
   * survives cropping — a circular mask inscribes a circle in it, and a wide
   * mark centred at full width has its extremities right on that circle. 0.88
   * pulls them off the edge. Eyeballed against a round launcher, which is the
   * tightest mask in common use.
   */
  const safe = size * (72 / 108) * 0.88;
  const markW = maxX - minX + 1;
  const markH = maxY - minY + 1;
  const scale = safe / Math.max(markW, markH);
  const drawW = markW * scale;
  const drawH = markH * scale;
  const originX = (size - drawW) / 2;
  const originY = (size - drawH) / 2;

  write(
    'mipmap-nodpi/ic_launcher_fg.png',
    encodePng(
      size,
      size,
      render(size, size, (x, y) => {
        const u = (x + 0.5 - originX) / scale + minX;
        const v = (y + 0.5 - originY) / scale + minY;
        return u < minX - 1 || v < minY - 1 || u > maxX + 1 || v > maxY + 1 ? 0 : sampleAt(u, v);
      }),
    ),
  );
}

const hex = '#' + bg.map((c) => c.toString(16).padStart(2, '0')).join('').toUpperCase();
console.log(`\nbrand background for ic_launcher_background: ${hex}`);
