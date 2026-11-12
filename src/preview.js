'use strict';
/**
 * 图标预览图：把真实渲染的位图按整数倍（最近邻）铺在深色 / 浅色任务栏底色上。
 * 纯 Node 合成 + 自写 PNG 编码，避免截图链路里的 DPI 非整数缩放把图弄糊。
 * 运行：node_modules/electron/dist/electron.exe src/preview.js
 */
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { makeIcon, prepare } = require('./icon');

/* ---- 解码本项目自产的 RGBA8 PNG（filter 0） ---- */
function decode(buf) {
  let p = 8, idat = [], w = 0, h = 0;
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.slice(p + 4, p + 8).toString('ascii');
    const data = buf.slice(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); }
    if (type === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const off = y * (w * 4 + 1) + 1;
    raw.copy(out, y * w * 4, off, off + w * 4);
  }
  return { w, h, rgba: out };
}
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
  return t;
})();
const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
const mkChunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
};
function encode(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (stride + 1)] = 0; rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), mkChunk('IHDR', ihdr),
    mkChunk('IDAT', zlib.deflateSync(raw, { level: 9 })), mkChunk('IEND', Buffer.alloc(0))]);
}

const CASES = [
  { mode: 'full',    abbr: 'PWR', value: '67', color: '#5dcaa5' },
  { mode: 'compact', abbr: 'NET', value: '19', color: '#7fb3ff' },
  { mode: 'compact', abbr: 'CPU', value: '23', color: '#b18cff' },
  { mode: 'plain',   abbr: 'MEM', value: '49', color: '#5ec8d8' }
];
const SIZES = [16, 24, 32];       // 100% / 150% / 200% 缩放下的托盘物理像素
const Z = 8;                      // 放大倍数
const BG = [[32, 32, 36], [243, 243, 243]];  // 深色 / 浅色任务栏

app.whenReady().then(async () => {
  await prepare(SIZES);
  const cell = 40 * Z, gap = 18, pad = 18;
  const blockW = SIZES.length * (cell + gap) + gap;
  const W = pad * 2 + blockW * BG.length;
  const rowH = 40 * Z + 16;
  const H = pad * 2 + CASES.length * rowH;

  const canvas = Buffer.alloc(W * H * 4);
  const fill = (x0, y0, w, h, c) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const o = (y * W + x) * 4;
      canvas[o] = c[0]; canvas[o + 1] = c[1]; canvas[o + 2] = c[2]; canvas[o + 3] = 255;
    }
  };
  fill(0, 0, W, H, [24, 24, 28]);

  BG.forEach((bg, bi) => {
    const bx = pad + bi * blockW;
    CASES.forEach((c, ri) => {
      const y0 = pad + ri * rowH;
      fill(bx - gap / 2, y0 - 4, blockW, rowH - 8, bg);
      SIZES.forEach((px, i) => {
        const { buffer } = makeIcon({ abbr: c.abbr, value: c.value, color: c.color, light: bg[0] > 128, mode: c.mode, px });
        const { w, h, rgba } = decode(buffer);
        const ox = bx + i * (cell + gap) + Math.round((cell - w * Z) / 2);
        const oy = y0 + Math.round((rowH - 8 - h * Z) / 2);
        for (let y = 0; y < h * Z; y++) {
          for (let x = 0; x < w * Z; x++) {
            const s = ((y / Z | 0) * w + (x / Z | 0)) * 4;
            const a = rgba[s + 3] / 255;
            if (!a) continue;
            const yy = oy + y, xx = ox + x;
            if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
            const o = (yy * W + xx) * 4;
            canvas[o] = Math.round(rgba[s] * a + canvas[o] * (1 - a));
            canvas[o + 1] = Math.round(rgba[s + 1] * a + canvas[o + 1] * (1 - a));
            canvas[o + 2] = Math.round(rgba[s + 2] * a + canvas[o + 2] * (1 - a));
            canvas[o + 3] = 255;
          }
        }
      });
    });
  });
  fs.writeFileSync(path.join(__dirname, '..', 'icon-preview.png'), encode(W, H, canvas));
  console.log('wrote icon-preview.png ' + W + 'x' + H +
    ' 左深底右浅底，每块 3 列=16/24/32px，4 行=full PWR·67 / compact N·19 / compact C·23 / plain 49');
  app.quit();
});
