'use strict';
// Deterministically reproduce the original, non-ABEMA icon artwork.
// No npm packages, remote resources or image libraries are required.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const sizes = [16, 32, 48, 128];

function rounded(x, y, x0, y0, w, h, radius) {
  const dx = Math.max(x0 + radius - x, 0, x - (x0 + w - radius));
  const dy = Math.max(y0 + radius - y, 0, y - (y0 + h - radius));
  return x >= x0 && x <= x0 + w && y >= y0 && y <= y0 + h
    && dx * dx + dy * dy <= radius * radius;
}

function triangle(x, y, a, b, c) {
  const sign = (p, q, r) => (p[0] - r[0]) * (q[1] - r[1])
    - (q[0] - r[0]) * (p[1] - r[1]);
  const point = [x, y];
  const d1 = sign(point, a, b), d2 = sign(point, b, c), d3 = sign(point, c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

function sample(x, y) {
  const bubble = rounded(x, y, 18, 18, 92, 79, 21);
  const tail = triangle(x, y, [44, 90], [37, 109], [68, 93]);
  if (!bubble && !tail) return [0, 0, 0, 0];

  const t = Math.min(1, Math.max(0, (y - 18) / 92));
  const g = (x - 18) / 92;
  let r = 30 - 10 * t + 4 * g;
  let green = 142 - 36 * t - 4 * g;
  let blue = 180 - 24 * t;

  const bar = (left, top, width, height) =>
    rounded(x, y, left, top, width, height, 2.7);
  if (bar(41, 58, 12, 22) || bar(60, 46, 12, 34) || bar(79, 54, 12, 26)) {
    r = 244; green = 252; blue = 249;
  }
  if ((x - 95) ** 2 + (y - 43) ** 2 < 5 ** 2) {
    r = 255; green = 208; blue = 98;
  }
  return [Math.round(r), Math.round(green), Math.round(blue), 255];
}

function raster(size) {
  const stride = size * 4 + 1;
  const raw = new Uint8Array(stride * size);
  const scale = 128 / size;
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // PNG filter: none
    for (let x = 0; x < size; x++) {
      let alpha = 0, r = 0, green = 0, blue = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const p = sample((x + (sx + .5) / 4) * scale,
            (y + (sy + .5) / 4) * scale);
          const a = p[3] / 255;
          alpha += a;
          r += p[0] * a;
          green += p[1] * a;
          blue += p[2] * a;
        }
      }
      const i = y * stride + 1 + x * 4;
      raw[i] = alpha ? Math.round(r / alpha) : 0;
      raw[i + 1] = alpha ? Math.round(green / alpha) : 0;
      raw[i + 2] = alpha ? Math.round(blue / alpha) : 0;
      raw[i + 3] = Math.round(alpha * 255 / 16);
    }
  }
  return raw;
}

const be32 = n => [(n >>> 24) & 255, (n >>> 16) & 255,
  (n >>> 8) & 255, n & 255];

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const header = [...type].map(c => c.charCodeAt(0));
  const bytes = [...header, ...data];
  return [...be32(data.length), ...bytes, ...be32(crc32(bytes))];
}

function png(size) {
  const raw = raster(size);
  const deflate = [0x78, 0x01]; // zlib + uncompressed DEFLATE blocks
  for (let pos = 0; pos < raw.length; pos += 65535) {
    const length = Math.min(65535, raw.length - pos);
    const end = pos + length === raw.length;
    deflate.push(end ? 1 : 0, length & 255, length >>> 8,
      (~length) & 255, ((~length) >>> 8) & 255);
    for (let i = pos; i < pos + length; i++) deflate.push(raw[i]);
  }
  let a = 1, b = 0;
  for (const value of raw) {
    a = (a + value) % 65521;
    b = (b + a) % 65521;
  }
  deflate.push(...be32(((b << 16) | a) >>> 0));
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  return Buffer.from([...signature,
    ...chunk('IHDR', [...be32(size), ...be32(size), 8, 6, 0, 0, 0]),
    ...chunk('IDAT', deflate), ...chunk('IEND', [])]);
}

function main() {
  const check = process.argv.includes('--check');
  if (check && process.argv.length > 3) throw new Error('Unsupported arguments');
  fs.mkdirSync(path.join(root, 'icons'), { recursive: true });
  for (const size of sizes) {
    const filename = path.join(root, 'icons', `icon-${size}.png`);
    const actual = png(size);
    if (check) {
      if (!fs.existsSync(filename) || !fs.readFileSync(filename).equals(actual)) {
        throw new Error(`Icon is missing or does not match the source: ${filename}`);
      }
    } else {
      fs.writeFileSync(filename, actual);
    }
  }
  process.stdout.write(check ? 'All four icons match the original source.\n'
    : 'Regenerated original icons in icons/.\n');
}

if (require.main === module) main();
module.exports = { png };
