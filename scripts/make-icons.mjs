// Renders the toolbar icons (a "focus target" on a rounded square) as PNGs with no dependencies.
// Usage: node scripts/make-icons.mjs  → writes static/icons/{on,off,paused}-{16,32,48,128}.png
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

const THEMES = {
  on: ["#4b95ea", "#1c5cab"],
  off: ["#a3a29c", "#5f5e5a"],
  paused: ["#f08a5d", "#c24a1c"],
};
const SIZES = [16, 32, 48, 128];
const SAMPLES = 4;

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

// Coverage of each shape at a point in unit coordinates (0..1).
function roundedSquare(x, y) {
  const r = 0.24, h = 0.5 - 0.02;
  const qx = Math.abs(x - 0.5) - (h - r), qy = Math.abs(y - 0.5) - (h - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r <= 0;
}
function glyph(x, y) {
  const d = Math.hypot(x - 0.5, y - 0.5);
  return Math.abs(d - 0.27) <= 0.06 || d <= 0.095;
}

function render(size, [from, to]) {
  const a = hex(from), b = hex(to);
  const px = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let pxl = 0; pxl < size; pxl++) {
      let bg = 0, fg = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = (pxl + (sx + 0.5) / SAMPLES) / size, y = (py + (sy + 0.5) / SAMPLES) / size;
          if (roundedSquare(x, y)) glyph(x, y) ? fg++ : bg++;
        }
      }
      const n = SAMPLES * SAMPLES, t = (pxl + py) / (2 * size);
      const cover = (bg + fg) / n, white = fg / Math.max(bg + fg, 1);
      const i = (py * size + pxl) * 4;
      for (let c = 0; c < 3; c++) px[i + c] = Math.round((a[c] + (b[c] - a[c]) * t) * (1 - white) + 255 * white);
      px[i + 3] = Math.round(cover * 255);
    }
  }
  return png(size, px);
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4), crc = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type), data]);
  len.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const out = new URL("../static/icons/", import.meta.url);
mkdirSync(out, { recursive: true });
for (const [name, colors] of Object.entries(THEMES)) {
  for (const size of SIZES) writeFileSync(new URL(`${name}-${size}.png`, out), render(size, colors));
}
console.log("icons written to static/icons/");
