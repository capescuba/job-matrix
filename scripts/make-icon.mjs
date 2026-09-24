// Generates scripts/job-matrix.ico (same design as apps/web/public/favicon.svg). No dependencies.
import fs from 'node:fs';
import zlib from 'node:zlib';

const BG = [0x2a, 0x78, 0xd6];

/** Coverage (0..1) of a point by a rounded rect, used with supersampling for antialiasing. */
const inRoundRect = (x, y, rx, ry, w, h, r) => {
  if (x < rx || y < ry || x > rx + w || y > ry + h) return false;
  const cx = Math.min(Math.max(x, rx + r), rx + w - r);
  const cy = Math.min(Math.max(y, ry + r), ry + h - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};

function render(size) {
  const ss = 4;
  const px = Buffer.alloc(size * size * 4);
  const cells = [];
  for (let row = 0; row < 3; row++)
    for (let col = 0; col < 3; col++)
      cells.push({ x: 12 + col * 14.5, y: 12 + row * 14.5, on: row === col });
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let bg = 0,
        white = 0;
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          // Design space is 64x64.
          const u = ((x + (sx + 0.5) / ss) / size) * 64;
          const v = ((y + (sy + 0.5) / ss) / size) * 64;
          if (!inRoundRect(u, v, 0, 0, 64, 64, 14)) continue;
          bg++;
          const c = cells.find((c) => inRoundRect(u, v, c.x, c.y, 11, 11, 3));
          if (c) white += c.on ? 1 : 0.45;
        }
      const n = ss * ss;
      const a = bg / n;
      const w = bg ? white / bg : 0;
      const i = (y * size + x) * 4;
      for (let k = 0; k < 3; k++) px[i + k] = Math.round(BG[k] * (1 - w) + 255 * w);
      px[i + 3] = Math.round(a * 255);
    }
  return px;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function png(size) {
  const rgba = render(size);
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++)
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const sizes = [16, 20, 24, 32, 40, 48, 64, 256];
const images = sizes.map(png);
const header = Buffer.alloc(6);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length;
const dir = sizes.map((s, i) => {
  const e = Buffer.alloc(16);
  e[0] = s === 256 ? 0 : s;
  e[1] = s === 256 ? 0 : s;
  e.writeUInt16LE(1, 4);
  e.writeUInt16LE(32, 6);
  e.writeUInt32LE(images[i].length, 8);
  e.writeUInt32LE(offset, 12);
  offset += images[i].length;
  return e;
});
const out = new URL('./job-matrix.ico', import.meta.url);
fs.writeFileSync(out, Buffer.concat([header, ...dir, ...images]));
fs.writeFileSync(new URL('./job-matrix-256.png', import.meta.url), images.at(-1));
console.log('wrote', out.pathname);
