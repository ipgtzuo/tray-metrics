'use strict';
const { app, Tray, Menu, BrowserWindow, nativeImage, screen, ipcMain, shell, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const { Metrics, TYPES, KEYS } = require('./metrics');
const { makeIcon, fallbackIcon, prepare, ready } = require('./icon');

const CONFIG_FILE = () => path.join(app.getPath('userData'), 'config.json');
let tray = null, panel = null, menu = null;
let current = 'net', taskbarTheme = 'auto', iconMode = 'compact';
let welcomeShown = false, quitting = false;
let platformBaseW = 12, wallPowerUrl = '';
let lastIconKey = '', lastIconUrl = '', lastClickAt = 0;
let idleTimer = null, pendingListMode = false, lastPanelH = 470, panelHSaveTimer = null;
const PANEL_IDLE_MS = 60000; // 面板隐藏后保留 60 秒，闲置则释放渲染进程
const PANEL_W = 348, PANEL_MIN_H = 300, PANEL_MAX_H = 760; // 高度随内容自适应
const metrics = new Metrics();

function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_FILE(), 'utf8'));
    if (c.current && KEYS.includes(c.current)) current = c.current;
    if (['auto', 'light', 'dark'].includes(c.taskbarTheme)) taskbarTheme = c.taskbarTheme;
    if (['compact', 'plain', 'full'].includes(c.iconMode)) iconMode = c.iconMode;
    if (Number.isFinite(c.panelH) && c.panelH >= PANEL_MIN_H && c.panelH <= PANEL_MAX_H) lastPanelH = Math.round(c.panelH);
    welcomeShown = !!c.welcomeShown;
    // 电池供电时用整机实测反推的平台基线；以及可选的外接电表 HTTP 端点
    if (Number.isFinite(c.platformBaseW) && c.platformBaseW >= 3 && c.platformBaseW <= 40) platformBaseW = c.platformBaseW;
    if (typeof c.wallPowerUrl === 'string') wallPowerUrl = c.wallPowerUrl;
  } catch (_) {}
  saveConfig();   // 补齐新增字段，用户任何时候打开配置文件都能看到并编辑
}
function saveConfig() {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE()), { recursive: true });
    fs.writeFileSync(CONFIG_FILE(), JSON.stringify({
      current, taskbarTheme, iconMode, welcomeShown, platformBaseW, wallPowerUrl, panelH: lastPanelH
    }, null, 2));
  } catch (_) {}
}
/** 任务栏深浅：优先用户手动指定，其次 PowerShell 读到的注册表值，最后用系统主题推断 */
function resolveLight() {
  if (taskbarTheme === 'light') return true;
  if (taskbarTheme === 'dark') return false;
  const fromReg = metrics.s.lightTaskbar;
  return fromReg === null ? !nativeTheme.shouldUseDarkColors : fromReg;
}

/* ---------------- 托盘图标 ---------------- */
/**
 * 图标上的数值。改用意宽点阵后「18.6」只占 13px，16px 位图也放得下，
 * 因此不再需要丢小数位——宁可多一位精度，也不要四舍五入骗人。
 */
function trayValue(k) {
  return metrics.text(k);
}
/**
 * 托盘图标实际栅格化的边长 = 16 逻辑像素 × 显示缩放。
 * 150% 缩放下是 24px，此时若只给 16px 位图，系统会把 16 放大到 24 —— 模糊的根源。
 */
function trayPixelSize() {
  const d = screen.getPrimaryDisplay();
  return Math.max(16, Math.round(16 * ((d && d.scaleFactor) || 1)));
}
function buildTrayImage() {
  const t = TYPES[current];
  const value = trayValue(current);
  const light = resolveLight();
  const px = trayPixelSize();
  const key = [current, value, light, iconMode, px].join('|');
  if (!ready(px)) { prepare([px, px * 4]).catch(() => {}); return null; }
  if (key !== lastIconKey) {
    let made;
    try {
      made = makeIcon({ abbr: t.abbr, value, color: t.color, light, mode: iconMode, px, previewPx: px * 4 });
    } catch (e) {
      console.error('[icon] 字体渲染失败，使用兜底图标:', e.message);
      made = fallbackIcon(px, t.color);
    }
    const { buffer, dataUrl } = made;
    /*
     * 关键：只放一个「1x」表示，且让它的像素尺寸等于屏幕物理尺寸。
     * 实测标注多档 scaleFactor 无效——Electron 在 Windows 上仍会把图标栅格化回
     * 16 逻辑像素生成 HICON，再由系统放大到 24px，导致笔画被插值成灰边。
     * 声明为 1x、尺寸即物理尺寸后，HICON 与托盘槽位 1:1。
     */
    const img = nativeImage.createEmpty();
    img.addRepresentation({ scaleFactor: 1, buffer });
    lastIconKey = key;
    lastIconUrl = dataUrl;
    return img;
  }
  return null;
}
function updateTray(force = false) {
  if (!tray) return;
  const img = buildTrayImage();
  if (img) tray.setImage(img);
  else if (force) { lastIconKey = ''; tray.setImage(buildTrayImage()); }
  const t = TYPES[current];
  // tooltip 承担完整语义，图标上就不必再堆字
  tray.setToolTip(`${t.name} ${metrics.display(current)} ${t.unit}`);
}
function setIconMode(m) {
  if (!['compact', 'plain', 'full'].includes(m)) return;
  iconMode = m; saveConfig();
  lastIconKey = ''; updateTray(true);
  pushSnapshot();
}

/* ---------------- 右键菜单 ---------------- */
/** 一级只放高频操作：切类型、看全部、退出；低频设置收进子菜单 */
function buildMenu() {
  const settings = [
    { type: 'radio', label: '简洁图标 · 字母 + 数值', checked: iconMode === 'compact', click: () => setIconMode('compact') },
    { type: 'radio', label: '极简图标 · 只显示数值', checked: iconMode === 'plain', click: () => setIconMode('plain') },
    { type: 'radio', label: '完整图标 · 三字母 + 数值', checked: iconMode === 'full', click: () => setIconMode('full') },
    { type: 'separator' },
    { label: '重新检测传感器', click: () => metrics.refreshSensors() },
    { label: '数据源说明', click: () => shell.openExternal('https://github.com/LibreHardwareMonitor/LibreHardwareMonitor') },
    // 打开前先落盘，确保配置文件里已有 platformBaseW / wallPowerUrl 两个字段可供编辑
    { label: '配置墙插功率接口…', click: () => { saveConfig(); shell.openPath(CONFIG_FILE()); } },
    { type: 'separator' },
    { type: 'checkbox', label: '任务栏为浅色（用深色文字）', checked: resolveLight(),
      click: item => {
        taskbarTheme = item.checked ? 'light' : 'dark';
        saveConfig(); lastIconKey = ''; updateTray(true);
      } },
    { type: 'checkbox', label: '开机自动启动', checked: app.getLoginItemSettings().openAtLogin,
      click: item => app.setLoginItemSettings({ openAtLogin: item.checked }) }
  ];
  return Menu.buildFromTemplate([
    ...KEYS.map(k => {
      const t = TYPES[k];
      const dv = metrics.display(k);
      return {
        type: 'radio', checked: k === current,
        label: `${t.name}    ${dv === '—' ? '—' : dv + ' ' + t.unit}`,
        click: () => setType(k)
      };
    }),
    { type: 'separator' },
    { label: '显示全部指标', click: () => openPanel(true) },
    { label: '设置', submenu: settings },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } }
  ]);
}

/* ---------------- 详情面板 ---------------- */
function createPanel() {
  panel = new BrowserWindow({
    width: PANEL_W, height: lastPanelH, show: false, frame: false, resizable: false,
    movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, alwaysOnTop: true, transparent: true, hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  });
  panel.setAlwaysOnTop(true, 'floating');
  // 首次创建时 loadFile 是异步的，页面就绪后再补推一次快照，避免空白面板
  panel.webContents.once('did-finish-load', () => pushSnapshot(pendingListMode, true));
  panel.loadFile(path.join(__dirname, 'panel.html'));
  panel.on('blur', () => {
    if (process.env.TM_PANEL_DEBUG) return;           // 调试截图时不要自动收起
    if (panel && !panel.webContents.isDevToolsOpened()) hidePanel();
  });
  panel.on('close', e => { if (!quitting) { e.preventDefault(); hidePanel(); } });
  panel.on('closed', () => { panel = null; });
}
function positionPanel() {
  if (!tray || !panel) return;
  const b = tray.getBounds();
  const display = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
  const wa = display.workArea;
  const [w, h] = panel.getSize();
  let x = Math.round(b.x + b.width / 2 - w / 2);
  x = Math.max(wa.x + 8, Math.min(x, wa.x + wa.width - w - 8));
  let y = b.y - h - 8;
  if (y < wa.y + 8) y = b.y + b.height + 8; // 任务栏在顶部时改为向下弹
  panel.setPosition(x, Math.round(y));
}
function pushSnapshot(listMode, force = false) {
  if (!panel || panel.isDestroyed() || (!force && !panel.isVisible())) return;
  const payload = {
    ...metrics.snapshot(), current, iconMode, iconUrl: lastIconUrl,
    updateText: new Date(metrics.updatedAt || Date.now()).toLocaleTimeString('zh-CN', { hour12: false })
  };
  // 只有明确指定时才覆盖面板的视图状态，否则每秒刷新会把「全部指标」踢回详情页
  if (listMode !== undefined) payload.listMode = !!listMode;
  panel.webContents.send('snapshot', payload);
}
/** 隐藏而非销毁，短时间内再点开能立刻显示；闲置超时后彻底释放渲染进程 */
function hidePanel() {
  if (!panel || panel.isDestroyed()) return;
  panel.hide();
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (panel && !panel.isDestroyed()) panel.destroy();
    panel = null;
  }, PANEL_IDLE_MS);
}
function openPanel(listMode = false, force = false) {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  // 首次点击才创建窗口；启动时没有 BrowserWindow，Electron 也不会拉起渲染/GPU 进程
  if (!panel || panel.isDestroyed()) createPanel();
  if (panel.isVisible() && !force) { hidePanel(); return; }
  pendingListMode = listMode;
  positionPanel();
  panel.show();
  panel.focus();
  pushSnapshot(listMode, true);
}
function setType(k) {
  if (!KEYS.includes(k)) return;
  current = k; saveConfig();
  updateTray(true);
  pushSnapshot(false);
}

/* ---------------- 跨 exe 全局单实例锁 ----------------
 * 重复启动时直接退出，并让已运行的实例弹出详情面板。 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => openPanel(false, true));

  app.whenReady().then(async () => {
    loadConfig();
    Menu.setApplicationMenu(null);

    // 先用系统真实字体把字形栅格化成图集（一次性，随后销毁隐藏窗口），
    // 之后每秒重绘只用纯 JS 贴图，不常驻渲染进程
    const px = trayPixelSize();
    await prepare([px, px * 4, 48, 96]).catch(e => console.error('[glyphs]', e.message));

    let initial;
    try {
      initial = makeIcon({
        abbr: TYPES[current].abbr, value: '--', color: TYPES[current].color,
        light: resolveLight(), mode: iconMode, px, previewPx: px * 4
      });
    } catch (e) {
      console.error('[glyphs] 初始图标渲染失败:', e.message);
      initial = fallbackIcon(px, TYPES[current].color);
    }
    const img = nativeImage.createEmpty();
    img.addRepresentation({ scaleFactor: 1, buffer: initial.buffer });
    tray = new Tray(img);
    tray.setToolTip('正在采集系统数据…');
    lastIconUrl = initial.dataUrl;
    lastIconKey = '';

    menu = buildMenu();

    // 不设置常驻 contextMenu：右键时即时构建，避免每秒刷新菜单导致闪烁
    tray.on('click', () => {
      const now = Date.now();
      if (now - lastClickAt < 260) return; // 双击时只响应一次
      lastClickAt = now;
      openPanel(false);
    });
    tray.on('right-click', () => {
      menu = buildMenu();
      tray.popUpContextMenu(menu);
    });
    tray.on('double-click', () => openPanel(false, true));

    ipcMain.on('set-type', (_e, k) => setType(k));
    ipcMain.on('close-panel', () => hidePanel());
    ipcMain.on('request-snapshot', (_e, listMode) => pushSnapshot(listMode));
    // 渲染进程量出卡片真实高度，这里贴着托盘底边调整窗口高度，
    // 保证「全部指标 / 数据源」永远在卡片内，不被窗口裁掉
    ipcMain.on('panel-height', (_e, h) => {
      if (!panel || panel.isDestroyed() || !tray) return;
      const open = panel.getBounds();
      const tb = tray.getBounds();
      const wa = screen.getDisplayNearestPoint({ x: tb.x + tb.width / 2, y: tb.y + tb.height / 2 }).workArea;
      const maxH = Math.min(PANEL_MAX_H, wa.height - 60);
      const nh = Math.round(Math.max(PANEL_MIN_H, Math.min(Number(h) || 0, maxH)));
      if (!Number.isFinite(nh) || Math.abs(nh - open.height) < 2) return;
      lastPanelH = nh; // 记住高度，下次重建面板时直接以该高度出现，避免先矮后高的跳动
      if (panelHSaveTimer) clearTimeout(panelHSaveTimer);
      panelHSaveTimer = setTimeout(() => { panelHSaveTimer = null; saveConfig(); }, 800);
      panel.setBounds({ x: open.x, y: open.y + open.height - nh, width: open.width, height: nh });
      positionPanel();
    });

    metrics.on('tick', () => {
      updateTray();
      pushSnapshot();
    });
    metrics.on('error', e => console.error('[metrics]', e.message));
    metrics.setPlatformBase(platformBaseW);
    metrics.setWallPowerUrl(wallPowerUrl);
    // 电池供电时自动校准基线后持久化，下次启动直接用校准值
    metrics.on('baseline', w => { platformBaseW = w; saveConfig(); });
    metrics.on('ps-exit', why => console.warn('[metrics] WMI 采集未完成: ' + why));
    // WMI 每 10 秒才更新一次主题读数，系统切换深浅时先丢弃旧值，让图标立刻重绘
    nativeTheme.on('updated', () => { metrics.s.lightTaskbar = null; lastIconKey = ''; updateTray(true); });
    // 换显示器 / 改缩放后要按新的物理尺寸重新生成位图与字号，否则内容会被放大发虚
    const onDisplayChange = () => {
      const p = trayPixelSize();
      prepare([p, p * 4]).then(() => { lastIconKey = ''; updateTray(true); }).catch(() => {});
    };
    screen.on('display-metrics-changed', onDisplayChange);
    screen.on('display-added', onDisplayChange);
    screen.on('display-removed', onDisplayChange);
    metrics.start();
    updateTray(true);
    // 调试用：TM_PANEL_DEBUG=1 启动后自动弹面板并把它自己截下来（核对高度自适应/底部不裁切）
    if (process.env.TM_PANEL_DEBUG) {
      setTimeout(() => openPanel(false, true), 1800);
      setTimeout(async () => {
        if (!panel || panel.isDestroyed()) return;
        try {
          const img = await panel.webContents.capturePage();
          const root = path.join(__dirname, '..');
          fs.writeFileSync(path.join(root, 'live-panel.png'), img.toPNG());
          fs.writeFileSync(path.join(root, 'live-panel.json'),
            JSON.stringify({ bounds: panel.getBounds(), png: img.getSize() }, null, 1));
        } catch (e) { /* 调试截图失败不影响运行 */ }
      }, 5200);
    }

    // 首次运行提示一次，帮用户在托盘（常收在 ^ 隐藏区）里找到新图标
    if (!welcomeShown) {
      setTimeout(() => {
        if (!tray) return;
        try {
          tray.displayBalloon({
            title: 'TrayMetrics 已启动',
            content: '托盘已新增实时数据图标。右键切换显示类型，左键查看详情；若没看到请点 ^ 展开。'
          });
        } catch (_) {}
        welcomeShown = true; saveConfig();
      }, 1800);
    }
  });

  // 托盘应用：关闭所有窗口也不退出
  app.on('window-all-closed', () => {});
  app.on('before-quit', () => {
    quitting = true;
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    metrics.stop();
    if (tray) { tray.destroy(); tray = null; }
    saveConfig();
  });
}
