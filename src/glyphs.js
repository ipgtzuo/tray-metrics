'use strict';
/**
 * 真实字体字形图集。
 *
 * 需求是「不要像素风，要单纯字体显示」，但托盘图标必须在纯主进程里每秒重绘，
 * 不能为了画字常驻一个渲染进程（会多 40–60MB 内存）。
 *
 * 折中做法：启动时开一个隐藏窗口，用系统真实字体（Segoe UI）把用到的字符栅格化
 * 成一小张灰度字形表，存进内存后立即销毁窗口；之后每秒只用纯 JS 把字形按整像素
 * 位置「贴」到位图上。抗锯齿来自浏览器自身的文字渲染，看起来就是普通小字，
 * 而不是手写点阵那种方块感。
 *
 * 字形缓存按 (字重, 字号) 存，跨图标尺寸复用；只有换 DPI 时才补新字号。
 */
const { app, BrowserWindow } = require('electron');

/*
 * 栅格化窗口是「一次性」的：渲染完立刻销毁。若此时应用里没有别的窗口，
 * Electron 会触发默认的 window-all-closed → 直接退出应用（后续页面全部
 * ERR_FAILED）。托盘应用本就不该因为窗口全关而退出，这里显式接管该事件。
 */
app.on('window-all-closed', () => {});

/* 图标上可能出现的字符：数字、小数点、负号、缩写字母 */
const CHARS = '0123456789.-:%/ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const STACK = '"Segoe UI Variable Text","Segoe UI","Microsoft YaHei UI",system-ui,sans-serif';

/** (weight|sizePx) -> { px, weight, asc, desc, capH, digitAdv, glyphs: Map<char, {adv,w,h,ox,alpha}> } */
const cache = new Map();

/* ---------------- 在页面里跑：真正的字形栅格化 ---------------- */
function pageRender(spec) {
  const { chars, stack, specs } = spec;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const toB64 = a => {
    let s = '';
    for (let i = 0; i < a.length; i += 4096) s += String.fromCharCode.apply(null, a.subarray(i, i + 4096));
    return btoa(s);
  };
  const out = [];
  for (const sp of specs) {
    const font = sp.weight + ' ' + sp.px + 'px ' + stack;
    ctx.font = font;
    // 用 H/g 取上下极限（字母上伸部 + 下伸部），数字/大写字母的行高按 '0' 的 ascent 算
    const m = ctx.measureText('Hg');
    const asc = Math.ceil(m.actualBoundingBoxAscent || sp.px * 0.8);
    const desc = Math.ceil(m.actualBoundingBoxDescent || sp.px * 0.2);
    const capH = Math.max(1, Math.round(ctx.measureText('0').actualBoundingBoxAscent || sp.px * 0.7));
    const glyphs = {};
    let digitAdv = 0;
    for (const ch of chars) {
      const adv = ctx.measureText(ch).width;
      if (ch >= '0' && ch <= '9') digitAdv = Math.max(digitAdv, adv);
      const w = Math.ceil(adv) + 2, h = asc + desc + 2;
      c.width = w; c.height = h;  // 改尺寸会重置 ctx 状态，下面重新设置
      ctx.font = font;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#ffffff';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(ch, 1, asc + 1);
      const d = ctx.getImageData(0, 0, w, h).data;
      const a = new Uint8Array(w * h);
      for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3];
      glyphs[ch] = { adv: Math.round(adv * 1000) / 1000, w, h, a: toB64(a) };
    }
    out.push({ px: sp.px, weight: sp.weight, asc, desc, capH, digitAdv, glyphs });
  }
  return out;
}

async function renderInPage(specs) {
  const win = new BrowserWindow({
    show: false, width: 240, height: 160, skipTaskbar: true, frame: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><meta charset="utf-8"><body></body>'));
    return await win.webContents.executeJavaScript(
      '(' + pageRender.toString() + ')(' + JSON.stringify({ chars: CHARS, stack: STACK, specs }) + ')');
  } finally {
    if (!win.isDestroyed()) win.destroy();  // 栅格化完就释放，避免常驻渲染进程
  }
}

/** 取（必要时先渲染）某个字重/字号的字形集合 */
async function ensureSizes(specs) {
  const need = specs.filter(s => !cache.has(s.weight + '|' + s.px));
  if (!need.length) return;
  const got = await renderInPage(need);
  for (const g of got) {
    const glyphs = new Map();
    for (const ch of Object.keys(g.glyphs)) {
      const it = g.glyphs[ch];
      glyphs.set(ch, { adv: it.adv, w: it.w, h: it.h, alpha: Buffer.from(it.a, 'base64') });
    }
    cache.set(g.weight + '|' + g.px, {
      px: g.px, weight: g.weight, asc: g.asc, desc: g.desc, capH: g.capH,
      digitAdv: g.digitAdv || g.px * 0.55, glyphs
    });
  }
}

/** 一行文字在某个字号下的像素宽度：数字统一用最宽数字的宽度，避免每秒跳动 */
function lineWidth(set, text) {
  let w = 0;
  for (const ch of String(text)) w += advOf(set, ch);
  return w;
}
function advOf(set, ch) {
  if (ch >= '0' && ch <= '9') return Math.round(set.digitAdv);
  const g = set.glyphs.get(ch);
  return g ? Math.round(g.adv) : 0;
}
function fontSizeList(px) {
  // 前几档是给「极简版式（只有数值）」用的：没有标签行时数值可以大很多
  const v = [0.94, 0.86, 0.78, 0.70, 0.62, 0.54, 0.46, 0.40].map(r => Math.max(6, Math.round(px * r)));
  const l = [0.52, 0.46, 0.40, 0.34, 0.28].map(r => Math.max(5, Math.round(px * r)));
  return {
    value: [...new Set(v)].map(s => ({ px: s, weight: 700 })),
    label: [...new Set(l)].map(s => ({ px: s, weight: 600 }))
  };
}
/** 为若干图标像素尺寸预渲染所需字号（同一字号只渲染一次） */
let pending = null;
async function prepare(pixelSizes) {
  // 托盘每秒都会调一次，构建期间复用在途任务，避免同时开多个隐藏窗口
  if (pending) return pending;
  pending = (async () => {
    const specs = [];
    for (const px of pixelSizes) {
      const f = fontSizeList(px);
      specs.push(...f.value, ...f.label);
    }
    const seen = new Set();
    await ensureSizes(specs.filter(s => {
      const k = s.weight + '|' + s.px;
      if (seen.has(k) || cache.has(k)) return false;
      seen.add(k); return true;
    }));
  })();
  try { await pending; } finally { pending = null; }
}
/** 该像素尺寸需要的字号是否都就绪 */
function ready(px) {
  const f = fontSizeList(px);
  return [...f.value, ...f.label].every(s => cache.has(s.weight + '|' + s.px));
}
/** 在候选字号里挑「能放下且最大」的一档 */
function pick(px, candidates, weight, text, maxW) {
  let fallback = null;
  for (const c of candidates) {
    const set = cache.get(weight + '|' + c.px);
    if (!set) continue;
    const w = lineWidth(set, text);
    if (!fallback) fallback = { set, w };
    if (w <= maxW) return { set, w };
  }
  return fallback;
}

/**
 * 整体排版：同时满足「宽度放得下」和「两行总高不超框」，返回数值/标签的字号与行距。
 * 数值优先取大字号，再为其配一个能放下的标签字号。
 */
function fit(px, label, value) {
  const f = fontSizeList(px);
  const maxW = px - 2;
  const gap = Math.max(2, Math.round(px * 0.10));
  const vCands = f.value.map(s => cache.get('700|' + s.px)).filter(Boolean);
  const lAll = f.label.map(s => cache.get('600|' + s.px)).filter(Boolean); // 字号从大到小
  for (const vs of vCands) {
    if (lineWidth(vs, value) > maxW) continue;
    if (!label) {
      if (vs.capH > px - 2) continue;
      return { vs, ls: null, gap, total: vs.capH };
    }
    // 标签字号 ≈ 数值的 0.62 倍，取不超过该值且能放下的最大可用档 → 类型与数值比例协调
    const target = vs.px * 0.62;
    const ls = lAll.find(s => s.px <= target && lineWidth(s, label) <= maxW) || lAll[lAll.length - 1];
    if (!ls) continue;
    const total = ls.capH + gap + vs.capH;
    if (total > px - 2) continue;      // 上下各留至少 1px 白边，避免贴边
    return { vs, ls, gap, total };
  }
  const vs = vCands[vCands.length - 1] || null;
  const ls = label ? (lAll[lAll.length - 1] || null) : null;
  return { vs, ls, gap, total: vs ? (ls ? ls.capH + gap : 0) + vs.capH : px };
}

module.exports = { prepare, ready, pick, fit, lineWidth, advOf, fontSizeList, CHARS };
