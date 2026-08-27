/**
 * Draws the yappy mark — violet squircle, tongue-out grin — as a 1024px PNG,
 * with nothing but node built-ins. `pnpm tauri icon` fans it out into every
 * platform size afterwards.
 */
const zlib = require('zlib');
const fs = require('fs');

const S = 1024;
const px = Buffer.alloc(S * S * 4);

// Palette (design language: violet surfaces, yellow tongue).
const VIOLET = [0x8b, 0x7c, 0xff];
const VIOLET_DEEP = [0x6c, 0x5c, 0xe7];
const INK = [0x1b, 0x19, 0x26];
const YELLOW = [0xff, 0xd8, 0x4a];

function put(x, y, rgb, a = 255) {
  const i = (y * S + x) * 4;
  px[i] = rgb[0];
  px[i + 1] = rgb[1];
  px[i + 2] = rgb[2];
  px[i + 3] = a;
}

for (let yi = 0; yi < S; yi++) {
  for (let xi = 0; xi < S; xi++) {
    // Normalised coords, -1..1, y down.
    const x = (xi / S) * 2 - 1;
    const y = (yi / S) * 2 - 1;

    // Squircle body.
    const n = 4;
    const a = 0.92;
    const body = Math.pow(Math.abs(x / a), n) + Math.pow(Math.abs(y / a), n);
    if (body > 1) continue; // transparent corner

    // Soft vertical gradient violet → deep violet.
    const t = (y + 1) / 2;
    let rgb = [
      Math.round(VIOLET[0] + (VIOLET_DEEP[0] - VIOLET[0]) * t),
      Math.round(VIOLET[1] + (VIOLET_DEEP[1] - VIOLET[1]) * t),
      Math.round(VIOLET[2] + (VIOLET_DEEP[2] - VIOLET[2]) * t),
    ];

    // Eyes.
    const eye = (cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
    if (eye(-0.34, -0.22, 0.13) || eye(0.34, -0.22, 0.13)) rgb = INK;

    // Grin: the lower half of a circle.
    const mcx = 0;
    const mcy = 0.14;
    const mr = 0.4;
    const inMouth = (x - mcx) ** 2 + (y - mcy) ** 2 <= mr * mr && y > mcy;
    if (inMouth) rgb = INK;

    // Tongue: a rounded lobe hanging out of the right side of the grin.
    const tcx = 0.18;
    const tw = 0.15;
    const ttop = 0.3;
    const tbot = 0.62;
    const inTongueRect = Math.abs(x - tcx) <= tw && y >= ttop && y <= tbot;
    const inTongueCap = (x - tcx) ** 2 + (y - tbot) ** 2 <= tw * tw;
    if (inTongueRect || inTongueCap) rgb = YELLOW;

    put(xi, yi, rgb);
  }
}

// ── PNG plumbing ────────────────────────────────────────────────────────────
const CRC_TABLE = new Int32Array(256).map((_, k) => {
  let c = k;
  for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const scanlines = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  px.copy(scanlines, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(scanlines, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync(`${__dirname}/icon-src.png`, png);
console.log('wrote icon-src.png', png.length, 'bytes');
