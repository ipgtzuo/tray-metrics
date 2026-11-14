'use strict';
const $ = id => document.getElementById(id);
let data = null, current = 'net', listMode = false, lastNeed = 0;

/** 把卡片真实高度报给主进程，由主进程贴着托盘调整窗口高度：
 *  内容长（说明文字多行 / 全部指标列表）时窗口变高，底部按钮永远留在卡片里。
 *  测量时临时去掉 min-height:100%，否则窗口只会变高不会变矮（棘轮效应）。 */
function reportHeight() {
  const card = document.querySelector('.card');
  if (!card) return;
  card.style.minHeight = '0px';
  const need = Math.ceil(card.getBoundingClientRect().height + 18);
  card.style.minHeight = '';
  if (Math.abs(need - lastNeed) > 2) { lastNeed = need; window.api.panelHeight(need); }
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function chart(hist, color) {
  const arr = (hist || []).filter(v => typeof v === 'number' && Number.isFinite(v));
  if (arr.length < 2) { $('line').setAttribute('d', ''); $('area').setAttribute('d', ''); return; }
  const lo = Math.min.apply(null, arr), hi = Math.max.apply(null, arr), sp = (hi - lo) || 1;
  const pts = arr.map((v, i) => [i / (arr.length - 1) * 300, 43 - ((v - lo) / sp) * 33]);
  const d = 'M' + pts.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' L');
  $('line').setAttribute('d', d);
  $('area').setAttribute('d', d + ' L300,48 L0,48 Z');
  $('line').setAttribute('stroke', color);
  $('area').setAttribute('fill', color);
}
function render() {
  if (!data) return;
  const t = data.types.find(x => x.key === current) || data.types[0];
  document.documentElement.style.setProperty('--tc', t.color);
  $('title').textContent = listMode ? '全部指标' : t.name + ' · 详情';
  $('clock').textContent = '更新于 ' + (data.updateText || '—');
  $('iconPreview').src = data.iconUrl || '';
  const ICON_DESC = {
    compact: '单字母类型 + 数值',
    plain: '仅数值 · 颜色表示类型',
    full: '三字母类型 + 数值'
  };
  const label = data.iconMode === 'full' ? t.abbr
    : data.iconMode === 'plain' ? '' : t.abbr.slice(0, 1);
  $('iconName').textContent = t.name + (label ? ' · ' + label : '');
  $('iconDesc').textContent = ICON_DESC[data.iconMode] || '类型 + 数值';
  $('source').textContent = '数据源 · ' + (listMode ? 'WMI / os / LHM' : t.source);
  $('btnToggle').textContent = listMode ? '返回详情' : '全部指标';
  $('detail').hidden = listMode;
  $('listView').hidden = !listMode;

  if (listMode) {
    $('listView').innerHTML = data.types.map(x =>
      '<button type="button" class="listrow" data-k="' + x.key + '">' +
        '<i class="sw" style="background:' + x.color + '"></i>' +
        '<span class="nm">' + esc(x.name) + '</span>' +
        '<span class="v' + (x.available ? '' : ' na') + '">' + esc(x.available ? x.display + ' ' + x.unit : '无数据') + '</span>' +
        (x.key === current ? '<span class="cur">当前</span>' : '') +
      '</button>'
    ).join('');
    requestAnimationFrame(reportHeight);
    return;
  }

  $('heroVal').textContent = t.display;
  $('heroUnit').textContent = t.available ? t.unit : '';
  $('heroSub').textContent = t.sub + ' · 刷新 1 s';
  $('rows').innerHTML = t.rows.map(r =>
    '<div class="row"><span>' + esc(r[0]) + '</span>' +
    (r[1] === null ? '<b class="na">— 无数据</b>' : '<b>' + esc(r[1]) + '</b>') + '</div>'
  ).join('');
  const notice = $('notice');
  if (t.reason) { notice.hidden = false; notice.textContent = t.reason; }
  else notice.hidden = true;
  chart(t.hist, t.color);
  requestAnimationFrame(reportHeight);
}

window.api.onSnapshot(d => {
  data = d;
  if (Object.prototype.hasOwnProperty.call(d, 'listMode')) listMode = !!d.listMode;
  current = d.current;
  render();
});
$('btnToggle').addEventListener('click', () => { listMode = !listMode; render(); });
$('btnX').addEventListener('click', () => window.api.close());
$('listView').addEventListener('click', e => {
  const b = e.target.closest('.listrow'); if (!b) return;
  current = b.dataset.k; listMode = false;
  window.api.setType(current);
  render();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') window.api.close(); });
document.addEventListener('contextmenu', e => e.preventDefault());
// 只请求一份快照，不要覆盖主进程指定的视图状态（例如右键「显示全部指标」打开列表页）
window.api.request();
