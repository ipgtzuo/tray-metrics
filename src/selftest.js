'use strict';
/** 无交互自检：验证原生图标、托盘、面板加载与采集层，结果写入 selftest-result.json 后退出。
 *  运行: node_modules/electron/dist/electron.exe src/selftest.js
 */
const { app, nativeImage, Tray, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { makeIcon, prepare } = require('./icon');
const { Metrics } = require('./metrics');

const RESULT = path.join(__dirname, '..', 'selftest-result.json');

app.whenReady().then(async () => {
  const out = { ok: false, electron: process.versions.electron, node: process.versions.node };
  let tray = null, win = null, m = null;
  try {
    await prepare([16, 20, 24, 28, 32, 48, 64, 96]);
    out.icons = {};
    for (const mode of ['compact', 'plain', 'full']) {
      const r = makeIcon({ abbr: 'NET', value: mode === 'full' ? '18.6' : '19', color: '#7fb3ff', light: false, mode, px: 24, previewPx: 96 });
      const im = nativeImage.createFromBuffer(r.buffer);
      out.icons[mode] = {
        size: im.getSize(), empty: im.isEmpty(),
        pngBytes: r.buffer.length,
        preview: r.dataUrl.length,
        layout: r.detail
      };
    }
    const r = makeIcon({ abbr: 'NET', value: '19', color: '#7fb3ff', light: false, mode: 'compact', px: 24 });
    const img = nativeImage.createFromBuffer(r.buffer);
    out.icon = { size: img.getSize(), empty: img.isEmpty(), toPNG: img.toPNG().length };

    tray = new Tray(img);
    tray.setToolTip('TrayMetrics selftest');
    out.tray = { created: true, bounds: tray.getBounds() };

    win = new BrowserWindow({
      width: 348, height: 470, show: false, frame: false, skipTaskbar: true,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
    });
    await win.loadFile(path.join(__dirname, 'panel.html'));
    out.panel = {
      title: await win.webContents.getTitle(),
      readyState: await win.webContents.executeJavaScript('document.readyState'),
      hasApi: await win.webContents.executeJavaScript('typeof window.api'),
      hasRows: await win.webContents.executeJavaScript('!!document.getElementById("rows")')
    };

    m = new Metrics();
    m.start();
    await new Promise(resolve => setTimeout(resolve, 6000));
    out.metrics = {
      net: m.value('net'), power: m.value('power'), cpu: m.value('cpu'),
      mem: m.value('mem'), disk: m.value('disk'), temp: m.value('temp'), gpu: m.value('gpu'),
      availability: { ...m.availability, wmiRuns: m.psRuns, wmiLastMs: m.psLastMs },
      samples: m.hist.cpu.length
    };
    out.ok = true;
  } catch (e) {
    out.error = e.stack || String(e);
  } finally {
    if (m) m.stop();
    if (tray) tray.destroy();
    if (win && !win.isDestroyed()) win.destroy();
    try { fs.writeFileSync(RESULT, JSON.stringify(out, null, 2)); } catch (_) {}
    console.log('SELFTEST ' + JSON.stringify(out));
    app.quit();
  }
});
