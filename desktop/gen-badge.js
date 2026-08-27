/** The taskbar overlay dot: accent violet, white ring, transparent ground. */
const zlib = require('zlib');
const fs = require('fs');

const S = 96;
const px = Buffer.alloc(S * S * 4);
for (let yi = 0; yi < S; yi++) {
  for (let xi = 0; xi < S; xi++) {
    const x = (xi / S) * 2 - 1;
    const y = (yi / S) * 2 - 1;
    const d = Math.sqrt(x * x + y * y);
    if (d > 0.96) continue;
    const i = (yi * S + xi) * 4;
    if (d > 0.74) {
      px[i] = 255; px[i + 1] = 255; px[i + 2] = 255; // white ring
    } else {
      px[i] = 0x8b; px[i + 1] = 0x7c; px[i + 2] = 0xff; // accent
    }
    px[i + 3] = 255;
  }
}

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
ihdr[8] = 8;
ihdr[9] = 6;
const scan = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) px.copy(scan, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
fs.writeFileSync(
  `${__dirname}/src-tauri/icons/badge.png`,
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(scan, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]),
);
console.log('wrote src-tauri/icons/badge.png');
