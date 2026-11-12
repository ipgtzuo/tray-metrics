'use strict';
/** 用真实采集数据检查详情面板底部按钮是否被挤出卡片 / 超出窗口。
 *  运行: node_modules/electron/dist/electron.exe src/footcheck.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { Metrics, KEYS } = require('./metrics');

const sleep = ms => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 348, height: 470, show: true, frame: false, transparent: true,
    backgroundColor: '#00000000', skipTaskbar: true, resizable: false, hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  });
  await win.loadFile(path.join(__dirname, 'panel.html'));
  // 模拟主进程的高度自适应：底部贴住不动，向上生长
  ipcMain.on('panel-height', (_e, h) => {
    const b = win.getBounds();
    const nh = Math.round(Math.max(300, Math.min(Number(h) || 0, 760)));
    if (!Number.isFinite(nh) || Math.abs(nh - b.height) < 2) return;
    win.setBounds({ x: b.x, y: b.y + b.height - nh, width: b.width, height: nh });
  });

  const m = new Metrics();
  m.start();
  await sleep(4000);
  const snap = m.snapshot();

  const measure = () => win.webContents.executeJavaScript(`(() => {
    const r = el => { if (!el) return null; const b = el.getBoundingClientRect();
      return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), bottom: Math.round(b.bottom), right: Math.round(b.right) }; };
    const card = document.querySelector('.card'), foot = document.querySelector('.foot');
    const btn = document.getElementById('btnToggle'), src = document.getElementById('source');
    const notice = document.getElementById('notice');
    const cb = card.getBoundingClientRect(), fb = foot.getBoundingClientRect(), bb = btn.getBoundingClientRect();
    return {
      winH: innerHeight, cardBottom: Math.round(cb.bottom), footBottom: Math.round(fb.bottom),
      btn: r(btn), src: r(src),
      footInsideCard: fb.bottom <= cb.bottom + 0.5 && fb.top >= cb.top,
      btnInsideCard: bb.bottom <= cb.bottom + 0.5 && bb.right <= cb.right + 0.5,
      btnOutsideWin: bb.bottom > innerHeight,
      overflowY: document.documentElement.scrollHeight > innerHeight,
      noticeLines: notice && !notice.hidden ? Math.round(notice.getBoundingClientRect().height) : 0,
      srcClipped: src ? src.scrollWidth > src.clientWidth + 1 : null
    };
  })()`);

  const out = {};
  for (const k of KEYS) {
    win.webContents.send('snapshot', { ...snap, current: k, iconMode: 'compact', iconUrl: '', updateText: '11:12:00', listMode: false });
    await sleep(520);
    out[k] = await measure();
  }
  win.webContents.send('snapshot', { ...snap, current: 'net', iconMode: 'compact', iconUrl: '', updateText: '11:12:00', listMode: true });
  await sleep(520);
  out.list = await measure();

  console.log('FOOT ' + JSON.stringify(out, null, 1));
  for (const name of ['power', 'temp', 'list']) {
    if (name === 'list') win.webContents.send('snapshot', { ...snap, current: 'net', iconMode: 'compact', iconUrl: '', updateText: '11:12:00', listMode: true });
    else win.webContents.send('snapshot', { ...snap, current: name, iconMode: 'compact', iconUrl: '', updateText: '11:12:00', listMode: false });
    await sleep(520);
    fs.writeFileSync(path.join(__dirname, '..', 'foot-' + name + '.png'), (await win.webContents.capturePage()).toPNG());
  }
  m.stop && m.stop();
  win.destroy();
  app.quit();
});
