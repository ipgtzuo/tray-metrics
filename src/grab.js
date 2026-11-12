'use strict';
/** 截取整个屏幕，用于核对真实运行中的面板位置/裁切。
 *  运行: node_modules/electron/dist/electron.exe src/grab.js
 */
const { app, desktopCapturer, screen } = require('electron');
const path = require('path');
const fs = require('fs');

app.setPath('userData', path.join(require('os').tmpdir(), 'tm-grab-' + Date.now()));

app.whenReady().then(async () => {
  const d = screen.getPrimaryDisplay();
  const srcs = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) }
  });
  const img = srcs[0].thumbnail;
  const out = path.join(__dirname, '..', 'live-screen.png');
  fs.writeFileSync(out, img.toPNG());
  console.log('GRAB ' + JSON.stringify({ out, size: img.getSize(), display: d.size, scale: d.scaleFactor }));
  app.quit();
});
