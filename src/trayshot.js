'use strict';
/**
 * 截取任务栏右侧区域并放大，用于核验托盘图标真实渲染效果（不创建任何托盘图标）。
 * 运行：env -u ELECTRON_RUN_AS_NODE electron src/trayshot.js
 */
const { app, screen, desktopCapturer } = require('electron');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
const chunk = (type, data) => {
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
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
function upscale(w, h, bgra, k) {
  const W = w * k, H = h * k;
  const out = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const s = ((y / k | 0) * w + (x / k | 0)) * 4;
      const d = (y * W + x) * 4;
      out[d] = bgra[s]; out[d + 1] = bgra[s + 1]; out[d + 2] = bgra[s + 2]; out[d + 3] = 255;
    }
  }
  return { w: W, h: H, buf: out };
}

const OUT = path.join(__dirname, '..');

app.whenReady().then(async () => {
  await new Promise(r => setTimeout(r, 800));
  const d = screen.getPrimaryDisplay();
  const W = Math.round(d.size.width * d.scaleFactor);
  const H = Math.round(d.size.height * d.scaleFactor);
  const src = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: W, height: H } });
  const thumb = src[0].thumbnail;
  const ts = thumb.getSize();
  const arg = (name, def) => {
    const hit = process.argv.find(a => a.startsWith('--' + name + '='));
    return hit ? Number(hit.split('=')[1]) : def;
  };
  const cw = Math.min(arg('w', 960), ts.width);
  const ch = Math.min(arg('h', 60), ts.height);
  const back = arg('back', 0);         // 从右边缘往左偏移多少物理像素再开始裁
  const zoom = Math.max(1, arg('zoom', 6));
  const crop = thumb.crop({ x: Math.max(0, ts.width - cw - back), y: ts.height - ch, width: cw, height: ch });
  const cs = crop.getSize();
  const tag = `w${cs.width}_b${back}_z${zoom}`;
  fs.writeFileSync(path.join(OUT, `tray-real-1x_${tag}.png`), crop.toPNG());
  const big = upscale(cs.width, cs.height, crop.toBitmap(), zoom);
  fs.writeFileSync(path.join(OUT, `tray-real-${zoom}x_${tag}.png`), encode(big.w, big.h, big.buf));
  console.log(`shot ${cs.width}x${cs.height} zoom=${zoom} -> tray-real-${zoom}x_${tag}.png`);
  app.quit();
});
