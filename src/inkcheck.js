'use strict';
/** 把生成的图标位图打成字符画，用来量真实墨迹范围（是否贴边/被裁）。
 *  运行: node_modules/electron/dist/electron.exe src/inkcheck.js
 */
const { app } = require('electron');
const zlib = require('zlib');
const { makeIcon, prepare } = require('./icon');

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

// 样例用「取整后」的托盘真实内容（net/power ≥10 取整），以反映字号放大效果
const CASES = [
  ['compact', 'NET', '19'],
  ['compact', 'CPU', '23'],
  ['full', 'PWR', '67'],
  ['plain', 'MEM', '49']
];

app.whenReady().then(async () => {
  await prepare([24]);
  for (const [mode, abbr, value] of CASES) {
    const { buffer, detail } = makeIcon({ abbr, value, color: '#7fb3ff', light: false, mode, px: 24 });
    const { w, h, rgba } = decode(buffer);
    let top = h, bottom = -1;
    const rows = [];
    for (let y = 0; y < h; y++) {
      let line = '';
      for (let x = 0; x < w; x++) {
        const a = rgba[(y * w + x) * 4 + 3];
        if (a > 0) { top = Math.min(top, y); bottom = Math.max(bottom, y); }
        line += a > 200 ? '#' : a > 90 ? '+' : a > 0 ? '.' : ' ';
      }
      rows.push(line);
    }
    console.log(`\n=== ${mode} ${abbr}/${value}  字号=${detail.fontPx} 标签=${detail.labelPx} 墨迹 y=${top}..${bottom} 高=${bottom - top + 1}/${h}`);
    rows.forEach((r, i) => console.log(String(i).padStart(2) + '|' + r + '|'));
  }
  app.quit();
});
