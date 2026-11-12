'use strict';
/**
 * 托盘图标位图（真实系统字体，不是点阵像素字）。
 *
 * 清晰度关键：Windows 托盘槽位是「16 逻辑像素 × 显示缩放」，150% 下只有 24×24
 * 物理像素。因此位图必须正好等于这个物理尺寸，并以 scaleFactor=1 交给系统，
 * 才能 1:1 映射、不被插值放大。
 *
 * 文字渲染：字形由系统字体（Segoe UI）先栅格化成图集（见 glyphs.js），
 * 这里只做整像素贴图 + Alpha 混合，因此每秒重绘不产生渲染进程开销。
 *
 * 三种版式：
 *   compact（默认）上行 1 个类型字母，下行数值
 *   plain            只画数值（数字可以画得更大）
 *   full             上行 3 字母缩写，下行数值
 */
const zlib = require('zlib');
const glyphs = require('./glyphs');

/* ---------------- PNG 编码 ---------------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------------- 颜色工具 ---------------- */
function parseHex(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
/** 浅色任务栏：把过亮的类型色压暗到可读 */
function darken(hex, amount) {
  const [r, g, b] = parseHex(hex);
  const k = 1 - amount;
  return '#' + [r, g, b].map(v => Math.round(v * k).toString(16).padStart(2, '0')).join('');
}

/* ---------------- 绘制 ---------------- */
/** 把一个字形贴到位图上（整像素，Alpha 混合，边缘保留系统抗锯齿） */
function blit(rgba, px, set, ch, x, baselineY, rgb) {
  const g = set.glyphs.get(ch);
  if (!g) return;
  // 字形位图：顶部留 1px，基线在 asc+1
  const ox = x - 1, oy = baselineY - set.asc - 1;
  for (let by = 0; by < g.h; by++) {
    const y = oy + by;
    if (y < 0 || y >= px) continue;
    for (let bx = 0; bx < g.w; bx++) {
      const a = g.alpha[by * g.w + bx];
      if (!a) continue;
      const xx = ox + bx;
      if (xx < 0 || xx >= px) continue;
      const o = (y * px + xx) * 4;
      if (a <= rgba[o + 3]) continue;
      rgba[o] = rgb[0]; rgba[o + 1] = rgb[1]; rgba[o + 2] = rgb[2]; rgba[o + 3] = a;
    }
  }
}
/** 一行文字：居中，返回实际占用宽度 */
function drawLine(rgba, px, set, text, baselineY, rgb) {
  const w = glyphs.lineWidth(set, text);
  let x = Math.round((px - w) / 2);
  for (const ch of String(text)) {
    blit(rgba, px, set, ch, x, baselineY, rgb);
    x += glyphs.advOf(set, ch);
  }
  return w;
}

/**
 * 生成图标位图。
 * @param {object} o
 * @param {string} o.abbr  三字母类型缩写（compact 取首字母）
 * @param {string} o.value 最多 4 字符的数值
 * @param {string} o.color 类型主色
 * @param {boolean} o.light 浅色任务栏
 * @param {string} [o.mode] 'compact' | 'plain' | 'full'
 * @param {number} [o.px]   位图边长（物理像素），默认 24
 * @param {number} [o.previewPx] 面板预览用的大图边长
 * @returns {{buffer:Buffer, dataUrl:string, detail:object}}
 */
function makeIcon({ abbr, value, color, light, mode = 'compact', px = 24, previewPx = 0 }) {
  if (!glyphs.ready(px)) throw new Error('图标字形未就绪，请先 await prepare(' + px + ')');
  const labelColor = light ? darken(color, 0.42) : color;
  // plain 模式没有类型字母，用类型色给数值上色，浅色任务栏下压暗
  const valueColor = mode === 'plain'
    ? (light ? darken(color, 0.38) : color)
    : (light ? '#1a1a20' : '#ffffff');
  const v = String(value || '--').slice(0, 4);
  const label = mode === 'plain' ? '' : (mode === 'compact' ? abbr.slice(0, 1) : abbr).toUpperCase();

  const compose = (size) => {
    const { vs, ls, gap } = glyphs.fit(size, label, v);
    if (!vs) throw new Error('图标字号缺失');
    const valCap = vs.capH;
    const labCap = ls ? ls.capH : 0;
    const total = labCap + (ls ? gap : 0) + valCap;
    const top = Math.round((size - total) / 2);
    const labBase = top + labCap;
    const valBase = labBase + (ls ? gap : 0) + valCap;
    const rgba = Buffer.alloc(size * size * 4);
    if (ls) drawLine(rgba, size, ls, label, labBase, parseHex(labelColor));
    drawLine(rgba, size, vs, v, valBase, parseHex(valueColor));
    return { rgba, vs, ls };
  };

  const main = compose(px);
  let dataUrl = '';
  if (previewPx) {
    const big = compose(previewPx);
    dataUrl = 'data:image/png;base64,' + encodePNG(previewPx, big.rgba).toString('base64');
  }

  return {
    buffer: encodePNG(px, main.rgba),
    dataUrl,
    detail: {
      lines: (label ? [label] : []).concat([v]),
      fontPx: main.vs.px,
      labelPx: main.ls ? main.ls.px : 0,
      width: glyphs.lineWidth(main.vs, v)
    }
  };
}

/** 兜底图标：字体栅格化万一不可用（极罕见），至少给一个类型色方块，不至于没图标 */
function fallbackIcon(px, color) {
  const rgba = Buffer.alloc(px * px * 4);
  const rgb = parseHex(color);
  const a = Math.round(px * 0.28), b = px - a;
  for (let y = a; y < b; y++) {
    for (let x = a; x < b; x++) {
      const o = (y * px + x) * 4;
      rgba[o] = rgb[0]; rgba[o + 1] = rgb[1]; rgba[o + 2] = rgb[2]; rgba[o + 3] = 255;
    }
  }
  return { buffer: encodePNG(px, rgba), dataUrl: '', detail: { lines: [], fontPx: 0, labelPx: 0, width: 0 } };
}

module.exports = { makeIcon, fallbackIcon, darken, prepare: glyphs.prepare, ready: glyphs.ready };
