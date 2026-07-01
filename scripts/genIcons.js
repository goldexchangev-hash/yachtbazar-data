// Generates PWA icons (no image libs needed — raw RGBA -> PNG via zlib).
// Draws a dark squircle-friendly tile with a glowing gold ETH coin.
const fs = require("fs");
const zlib = require("zlib");

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(S, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(S * (S * 4 + 1));
  for (let y = 0; y < S; y++) {
    raw[y * (S * 4 + 1)] = 0; // filter none
    rgba.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

function lerp(a, b, t) { return a + (b - a) * t; }
function inPoly(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
    if (((yi > py) !== (yj > py)) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function drawIcon(S) {
  const buf = Buffer.alloc(S * S * 4);
  const cx = S / 2, cy = S / 2, R = S * 0.33;
  const hx = cx - R * 0.32, hy = cy - R * 0.32; // highlight point
  const s = R * 0.72;
  const topD = [[cx, cy - s], [cx - s * 0.55, cy], [cx, cy + s * 0.18], [cx + s * 0.55, cy]];
  const botD = [[cx, cy + s * 0.34], [cx - s * 0.55, cy + s * 0.1], [cx, cy + s], [cx + s * 0.55, cy + s * 0.1]];
  const put = (x, y, r, g, b, a) => {
    const i = (y * S + x) * 4, ia = a / 255, na = 1 - ia;
    buf[i] = r * ia + buf[i] * na; buf[i + 1] = g * ia + buf[i + 1] * na;
    buf[i + 2] = b * ia + buf[i + 2] * na; buf[i + 3] = Math.min(255, buf[i + 3] + a);
  };
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      // dark base
      put(x, y, 12, 13, 22, 255);
      const d = Math.hypot(x - cx, y - cy);
      // gold glow halo just outside the coin
      if (d > R && d < R * 1.5) {
        const g = Math.max(0, 1 - (d - R) / (R * 0.5));
        put(x, y, 255, 200, 60, (g * g * 150) | 0);
      }
      if (d <= R) {
        // gold body: highlight -> deep amber by distance from highlight
        const t = Math.min(1, Math.hypot(x - hx, y - hy) / (R * 1.7));
        let r = lerp(255, 169, t), gg = lerp(243, 118, t), b = lerp(176, 10, t);
        if (d > R * 0.9) { r = 122; gg = 77; b = 0; } // dark rim
        else if (d > R * 0.82) { r = 232; gg = 165; b = 42; } // rim band
        put(x, y, r | 0, gg | 0, b | 0, 255);
        // ETH diamond engraved (dark gold)
        if (inPoly(x, y, topD) || inPoly(x, y, botD)) put(x, y, 74, 53, 0, 205);
      }
    }
  }
  return buf;
}

for (const S of [192, 512]) {
  fs.writeFileSync(`public/icon-${S}.png`, encodePNG(S, drawIcon(S)));
  console.log(`wrote public/icon-${S}.png`);
}
fs.writeFileSync("public/apple-touch-icon.png", encodePNG(180, drawIcon(180)));
console.log("wrote public/apple-touch-icon.png");
