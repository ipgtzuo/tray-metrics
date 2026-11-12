'use strict';
/** 一次性截图脚本：把详情面板按真实尺寸渲染出来并保存 PNG，用于核对布局。
 *  运行: node_modules/electron/dist/electron.exe src/shot.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { makeIcon, prepare } = require('./icon');
let ICON_URL = '';

const T = (key, name, abbr, color, unit, display, sub, source, rows, hist) => ({
  key, name, abbr, color, unit, display, sub, source, rows,
  hist: hist || Array.from({ length: 30 }, (_, i) => 40 + Math.sin(i / 3) * 12),
  reason: '', available: true
});

const types = [
  T('net', '网速', 'NET', '#7fb3ff', 'MB/s', '1.7', '下行 · WLAN · netstat 差分',
    'netstat -e · 累计字节时间戳差分',
    [['下行速度', '1.7 MB/s'], ['上行速度', '0.2 MB/s'], ['活动网卡', 'WLAN'], ['会话累计', '3.4 GB']]),
  T('power', '整机功率', 'PWR', '#5dcaa5', 'W', '52', 'CPU 封装 + GPU + 平台基线',
    'RAPL / Power Meter / nvidia-smi · 实测优先',
    [['当前读数', '52.3 W'], ['CPU 封装', '38.5 W · RAPL 实测'], ['GPU 功耗', '1.8 W · nvidia-smi'], ['平台基线', '12.0 W · 屏幕/内存/主板']]),
  T('cpu', 'CPU', 'CPU', '#a78bfa', '%', '12', '32 逻辑核 · 2.4 GHz',
    'os.cpus() · 两次采样差分',
    [['占用率', '12 %'], ['频率', '2.42 GHz'], ['峰值核心', '31 %'], ['逻辑核', '32']]),
  T('mem', '内存', 'MEM', '#1d9e75', '%', '51', '16.4 / 31.8 GB',
    'os.totalmem / os.freemem · 2 秒刷新',
    [['已用', '16.4 GB'], ['可用', '15.4 GB'], ['总量', '31.8 GB'], ['缓存', '3.1 GB']]),
  T('disk', '磁盘', 'DSK', '#ef9f27', '%', '76', 'C: · 300 GB',
    'fs.statfs / WMI · 占用 2 秒 / 速率 10 秒',
    [['C: 占用', '75.8 %'], ['已用', '341 GB'], ['总量', '450 GB'], ['读写速率', '1.2 MB/s']]),
  T('temp', '温度', 'TMP', '#f0784a', '°C', '37', 'GPU 核心 · NVIDIA',
    'LHM :8085 / nvidia-smi',
    [['GPU 核心', '37 °C'], ['CPU 封装', '— 无数据'], ['硬盘', '— 无数据'], ['风扇', '— 无数据']]),
  T('gpu', 'GPU', 'GPU', '#d4537e', '%', '2', '显存 1.4 GB',
    'LHM GPU Core / nvidia-smi',
    [['占用率', '2 %'], ['显存', '1.4 GB'], ['核心温度', '37 °C'], ['功耗', '1.8 W']])
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  await prepare([24, 96]);
  ICON_URL = makeIcon({ abbr: 'NET', value: '19', color: '#7fb3ff', light: false, mode: 'compact', px: 24, previewPx: 96 }).dataUrl;
  const win = new BrowserWindow({
    width: 348, height: 470, show: true, frame: false, transparent: true,
    backgroundColor: '#00000000', skipTaskbar: true, resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  });
  await win.loadFile(path.join(__dirname, 'panel.html'));
  await sleep(300);

  const out = {};
  const snap = listMode => ({ types, current: 'net', iconMode: 'compact', iconUrl: ICON_URL, updateText: '10:58:12', listMode });

  for (const listMode of [false, true]) {
    win.webContents.send('snapshot', snap(listMode));
    await sleep(450);
    out[listMode ? 'list' : 'detail'] = await win.webContents.executeJavaScript(`(() => {
      const g = id => { const e = document.getElementById(id); if (!e) return null;
        const r = e.getBoundingClientRect();
        return { id, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) }; };
      const btn = g('btnToggle'), src = g('source');
      const se = document.getElementById('source');
      const overlap = (a, b) => !!a && !!b && a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom;
      return {
        btnToggle: btn, source: src,
        srcVsBtnGap: (src && btn) ? btn.x - src.right : null,
        overlapSrcBtn: overlap(src, btn),
        srcClipped: se ? se.scrollWidth > se.clientWidth + 1 : null,
        srcBoxW: se ? Math.round(se.getBoundingClientRect().width) : null,
        srcTextW: se ? se.scrollWidth : null,
        docOverflowX: document.documentElement.scrollWidth > innerWidth,
        docOverflowY: document.documentElement.scrollHeight > innerHeight
      };
    })()`);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(__dirname, '..', listMode ? 'shot-list.png' : 'shot-detail.png'), img.toPNG());
  }

  console.log('LAYOUT ' + JSON.stringify(out, null, 2));
  win.destroy();
  app.quit();
});
