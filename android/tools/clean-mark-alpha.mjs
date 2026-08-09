/**
 * Clear the alpha wash out of the logo mark.
 *
 *   node tools/clean-mark-alpha.mjs
 *
 * The mark as supplied is not actually transparent: every pixel of the canvas
 * carries alpha 6 out of 255, so the "transparent" logo paints a faint square
 * wherever it is placed. Invisible at 22 dp in the header, obvious at 52 dp on
 * the sign-in screen, and worse under `gradientFill`, which paints the gradient
 * through whatever alpha it finds and so tints the whole rectangle.
 *
 * Anything below the cutoff becomes fully clear. The cutoff is well under the
 * antialiased edge values, so the outline keeps its softness — this removes a
 * flat background, not detail.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';

/** Alpha at or below this is background. The wash measured 6. */
const CUTOFF = 16;

const TARGETS = [
  new URL('../app/src/main/res/drawable-nodpi/logo_mark.png', import.meta.url),
  new URL('../../web/mark.png', import.meta.url),
];

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function decode(buf) {
  let p = 8;
  let width = 0, height = 0, colorType = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    if (type === 'IHDR') {
      width = buf.readUInt32BE(p + 8);
      height = buf.readUInt32BE(p + 12);
      if (buf[p + 16] !== 8) throw new Error('expected 8-bit channels');
      colorType = buf[p + 17];
    }
    if (type === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + len));
    if (type === 'IEND') break;
    p += 12 + len;
  }
  if (colorType !== 6) throw new Error(`expected RGBA, got colour type ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4 + 1;
  const pixels = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(width * 4);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * stride];
    const line = raw.subarray(y * stride + 1, (y + 1) * stride);
    const cur = Buffer.alloc(width * 4);
    for (let i = 0; i < width * 4; i++) {
      const a = i >= 4 ? cur[i - 4] : 0;
      const b = prev[i];
      const c = i >= 4 ? prev[i - 4] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 255;
    }
    cur.copy(pixels, y * width * 4);
    prev = cur;
  }
  return { width, height, pixels };
}

function encode({ width, height, pixels }) {
  // Filter 0 on every row. Larger than an optimal encoder would manage, and
  // entirely adequate for a one-off asset.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const target of TARGETS) {
  const image = decode(readFileSync(target));
  let cleared = 0;
  for (let i = 3; i < image.pixels.length; i += 4) {
    if (image.pixels[i] <= CUTOFF && image.pixels[i] !== 0) {
      image.pixels[i] = 0;
      // Zero the colour too. A fully transparent pixel that still carries a
      // colour will bleed it when the image is scaled, because filtering
      // averages RGB without regard to alpha.
      image.pixels[i - 3] = 0;
      image.pixels[i - 2] = 0;
      image.pixels[i - 1] = 0;
      cleared++;
    }
  }
  writeFileSync(target, encode(image));
  console.log(`${target.pathname.split('/').pop()}: cleared ${cleared} washed pixels`);
}
