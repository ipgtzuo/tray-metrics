'use strict';
/**
 * 把托盘区域真实像素打成字符画，用于判断图标笔画是否落在整像素上。
 * 运行：env -u ELECTRON_RUN_AS_NODE electron src/trayascii.js --w=120 --h=40 --back=430
 */
const { app, screen, desktopCapturer } = require('electron');

app.whenReady().then(async () => {
  await new Promise(r => setTimeout(r, 600));
  const arg = (n, d) => {
    const hit = process.argv.find(a => a.startsWith('--' + n + '='));
    return hit ? Number(hit.split('=')[1]) : d;
  };
  const d = screen.getPrimaryDisplay();
  const src = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(d.size.width * d.scaleFactor),
      height: Math.round(d.size.height * d.scaleFactor)
    }
  });
  const thumb = src[0].thumbnail;
  const ts = thumb.getSize();
  const w = arg('w', 120), h = arg('h', 40), back = arg('back', 430);
  const crop = thumb.crop({ x: Math.max(0, ts.width - w - back), y: ts.height - h, width: w, height: h });
  const cs = crop.getSize();
  const bmp = crop.toBitmap(); // BGRA

  const rows = [];
  for (let y = 0; y < cs.height; y++) {
    let line = '';
    for (let x = 0; x < cs.width; x++) {
      const o = (y * cs.width + x) * 4;
      const lum = 0.114 * bmp[o] + 0.587 * bmp[o + 1] + 0.299 * bmp[o + 2];
      line += lum > 160 ? '#' : lum > 80 ? '+' : lum > 32 ? '.' : ' ';
    }
    rows.push(String(y).padStart(2, ' ') + '|' + line + '|');
  }
  console.log(rows.join('\n'));
  console.log('   ' + Array.from({ length: cs.width }, (_, i) => i % 10).join(''));

  // 统计：非背景像素的纵向范围，判断内容高度（16px 模板 -> 约 11；24px 模板 -> 约 22）
  let minY = 999, maxY = -1;
  for (let y = 0; y < cs.height; y++) {
    for (let x = 0; x < cs.width; x++) {
      const o = (y * cs.width + x) * 4;
      const lum = 0.114 * bmp[o] + 0.587 * bmp[o + 1] + 0.299 * bmp[o + 2];
      if (lum > 80) { if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
  }
  console.log(`内容纵向范围: y=${minY}..${maxY} 高度=${maxY - minY + 1}px`);
  app.quit();
});
