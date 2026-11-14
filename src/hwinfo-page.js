'use strict';
/* 系统信息窗口的渲染层：只消费主进程推送的数据，不直接访问任何系统接口。 */
const $ = s => document.querySelector(s);
const E = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const BUS = { 7: 'USB', 10: 'SAS', 11: 'SATA', 12: 'SD', 13: 'MMC', 17: 'NVMe' };
const MEDIA = { 3: 'HDD 机械盘', 4: 'SSD 固态盘', 5: 'SCM 存储级内存' };
let summaryText = '';
let hasData = false;
let refreshing = false;

function row(k, v, unit, cls, liveKey) {
  const missing = v === null || v === undefined || v === '' ||
    (typeof v === 'number' && !Number.isFinite(v));
  const text = missing ? '—' : E(v) + E(unit || '');
  const attrs = (liveKey ? ` data-live="${E(liveKey)}"` : '') +
    (cls === 'hl' ? ' data-hl="1"' : '');
  return `<div class="row"><span>${E(k)}</span><b class="${missing ? 'na' : (cls || '')}"${attrs}>${text}</b></div>`;
}
/* 窗口打开期间，主进程每次采样都会推送实时值；这里只就地改数字，不重建整页 */
const withUnit = (v, digits, unit, scale) =>
  (typeof v === 'number' && Number.isFinite(v)) ? num(v * (scale || 1), digits) + unit : null;
const LIVE_FMT = {
  cpuMHz: v => withUnit(v, 2, ' GHz', 0.001),
  cpuPct: v => withUnit(v, 1, ' %'),
  gpuPct: v => withUnit(v, 1, ' %'),
  gpuTempC: v => withUnit(v, 0, ' °C'),
  gpuW: v => withUnit(v, 1, ' W'),
  powerW: v => withUnit(v, 1, ' W'),
  memUsedGB: v => withUnit(v, 1, ' GB'),
  batteryPct: v => withUnit(v, 0, ' %')
};
function applyLive(live) {
  if (!live) return;
  document.querySelectorAll('[data-live]').forEach(el => {
    const key = el.getAttribute('data-live');
    const fmt = LIVE_FMT[key];
    const text = fmt ? fmt(live[key]) : null;
    // 本轮没采到就保留已显示的值（例如静态采集到的电量），不要闪成「—」
    if (!text) return;
    el.textContent = text;
    el.className = el.getAttribute('data-hl') ? 'hl' : '';
  });
}
function card(title, rows, subs, tag) {
  return `<section class="card"><h2>${E(title)}${tag ? `<span class="tag">${E(tag)}</span>` : ''}</h2>` +
    `<div class="rows">${rows.join('')}</div>` +
    (subs || []).map(s => `<div class="sub">${s}</div>`).join('') + '</section>';
}
function num(v, digits) {
  return (typeof v === 'number' && Number.isFinite(v)) ? Number(v.toFixed(digits == null ? 1 : digits)) : null;
}
function gb(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return v >= 1024 ? num(v / 1024, 2) + ' TB' : num(v, 1) + ' GB';
}
function time(t) {
  if (!t) return null;
  const d = new Date(t);
  return isNaN(d.getTime()) ? String(t) : d.toLocaleString('zh-CN', { hour12: false });
}
function setBusy(on) {
  refreshing = on;
  const b = $('#btnRefresh');
  b.disabled = on;
  b.textContent = on ? '刷新中…' : '刷新';
}

function render(d) {
  if (!d) return;
  const m = d.machine || {}, c = d.cpu || {}, mem = d.memory || {}, bat = d.battery || {};
  const nv = d.nvidia || null, live = d.live || {}, meta = d.meta || {};
  const displays = Array.isArray(d.displays) ? d.displays : [];
  const gpus = Array.isArray(d.gpus) ? d.gpus : [];
  const disks = Array.isArray(d.disks) ? d.disks : [];
  const parts = Array.isArray(d.partitions) ? d.partitions : [];
  const mons = Array.isArray(d.monitors) ? d.monitors : [];
  const nets = Array.isArray(d.network) ? d.network : [];
  const lines = [];
  const cards = [];

  /* ---- 整机 / 系统 ---- */
  const modelLine = [m.manufacturer, m.family || m.model].filter(Boolean).join(' ');
  const machineRows = [
    row('机型', modelLine || null),
    row('型号 / MTM', m.model),
    row('主板', m.board),
    row('BIOS', m.bios ? `${m.bios}${m.biosDate ? ' (' + m.biosDate + ')' : ''}` : null),
    row('操作系统', m.os),
    row('版本 / 架构', m.osBuild ? `${m.osBuild} · ${m.osArch || ''}` : null),
    row('上次启动', m.bootTime),
    row('虚拟化', m.hypervisor ? '已检测到虚拟机监控程序' : (c.vtEnabled ? '固件已开启' : '未启用'))
  ];
  cards.push(card('整机与系统', machineRows, m.sku ? [`产品编号：${E(m.sku)}`] : []));
  lines.push('[整机与系统]', `机型: ${modelLine || '—'}`, `型号: ${m.model || '—'}`,
    `主板: ${m.board || '—'}`, `BIOS: ${m.bios || '—'} ${m.biosDate || ''}`,
    `操作系统: ${m.os || '—'} ${m.osBuild || ''}`, `上次启动: ${m.bootTime || '—'}`);

  /* ---- 处理器 ---- */
  const cpuRows = [
    row('型号', c.name),
    row('核心 / 线程', c.cores != null ? `${c.cores} 核 / ${c.threads} 线程` : null),
    row('基准频率', c.baseMHz ? num(c.baseMHz / 1000, 2) : null, ' GHz'),
    row('当前频率', live.cpuMHz ? num(live.cpuMHz / 1000, 2) : null, ' GHz', 'hl', 'cpuMHz'),
    row('当前占用', num(live.cpuPct, 1), ' %', '', 'cpuPct'),
    row('L2 / L3 缓存', c.l2KB != null ? `${num(c.l2KB / 1024, 0)} MB / ${num(c.l3KB / 1024, 0)} MB` : null),
    row('插槽', c.socket)
  ];
  cards.push(card('处理器', cpuRows, [], '实时频率来自 PDH 计数器'));
  lines.push('', '[处理器]', `型号: ${c.name || '—'}`,
    `核心/线程: ${c.cores || '—'}C / ${c.threads || '—'}T`,
    `基准频率: ${c.baseMHz ? num(c.baseMHz / 1000, 2) + ' GHz' : '—'}`,
    `当前频率: ${live.cpuMHz ? num(live.cpuMHz / 1000, 2) + ' GHz' : '—'}`);

  /* ---- 显卡 ---- */
  gpus.forEach((g, i) => {
    const vram = nv && nv.vramMiB ? num(nv.vramMiB / 1024, 1) + ' GB' :
      (g.vramBytes ? gb(g.vramBytes / 1073741824) : null);
    const gpuRows = [
      row('名称', g.name),
      row('显存', vram),
      row('驱动版本', (nv && nv.driver) || g.driver),
      row('驱动日期', g.driverDate),
      row('VBIOS', nv && nv.vbios),
      row('最大加速频率', nv && nv.maxClocksMHz, ' MHz'),
      row('当前输出', g.width ? `${g.width} × ${g.height} @ ${g.refresh || '—'} Hz` : null),
      row('实时利用率', num(live.gpuPct, 1), ' %', 'hl', 'gpuPct'),
      row('实时温度', num(live.gpuTempC, 0), ' °C', 'hl', 'gpuTempC'),
      row('实时功耗', num(live.gpuW, 1), ' W', 'hl', 'gpuW')
    ];
    const gpuSubs = [];
    if (g.processor && g.processor !== g.name) gpuSubs.push(`核心：${E(g.processor)}`);
    if (g.width) gpuSubs.push('当前输出为 WMI 适配器模式；多屏时以「显示器」卡片为准');
    cards.push(card(gpus.length > 1 ? `显卡 ${i + 1}` : '显卡', gpuRows, gpuSubs,
      nv ? '显存 / VBIOS 来自 nvidia-smi' : '来自 WMI'));
    lines.push('', '[显卡]', `名称: ${g.name || '—'}`, `显存: ${vram || '—'}`,
      `驱动: ${(nv && nv.driver) || g.driver || '—'}`,
      `输出: ${g.width ? g.width + ' x ' + g.height + ' @ ' + g.refresh + ' Hz' : '—'}`);
  });

  /* ---- 显示器 ---- */
  const dispRows = [];
  displays.forEach((d, i) => {
    const name = d.label || (d.internal ? '内置屏' : `显示器 ${i + 1}`);
    const scale = d.scale || 1;
    // bounds 是 DIP 逻辑像素。部分 Electron/Windows 组合下 size 也返回 DIP，
    // 只有明显大于 bounds 时才当作物理值用，否则按缩放推算。
    const calcW = Math.round(d.w * scale), calcH = Math.round(d.h * scale);
    const pw = (d.physW && d.physW > d.w * 1.1) ? d.physW : calcW;
    const ph = (d.physH && d.physH > d.h * 1.1) ? d.physH : calcH;
    dispRows.push(row(`${d.primary ? '主屏' : '副屏'} · ${d.internal ? '内置' : '外接'}`,
      d.w ? `${d.w} × ${d.h}` : null));
    dispRows.push(row('物理分辨率（推算）', d.w ? `约 ${pw} × ${ph}` : null));
    dispRows.push(row('刷新率 / 缩放', d.freq ? `${d.freq} Hz` : null,
      d.scale ? ` · ${Math.round(scale * 100)}%` : ''));
    dispRows.push(row('名称', name));
  });
  if (!dispRows.length) dispRows.push(row('显示输出', '未获取到'));
  const edidSubs = mons.map(x => {
    const label = [x.vendor, x.name || x.label].filter(Boolean).join(' ') || '未知面板';
    const size = x.diagonalIn ? `${x.diagonalIn} 英寸 (${x.widthCm} × ${x.heightCm} cm)` : '';
    const made = x.year ? `${x.year} 年第 ${x.week} 周` : '';
    return `${E(label)}${size ? ' · ' + E(size) : ''}${made ? ' · 生产于 ' + E(made) : ''}`;
  });
  cards.push(card('显示器', dispRows, edidSubs.length ? ['面板 EDID：', ...edidSubs] : [],
    `当前 ${displays.length} 路输出 · 已识别 ${mons.length} 块面板`));
  lines.push('', '[显示器]');
  displays.forEach(d => {
    const s = d.scale || 1;
    const pw = (d.physW && d.physW > d.w * 1.1) ? d.physW : Math.round(d.w * s);
    const ph = (d.physH && d.physH > d.h * 1.1) ? d.physH : Math.round(d.h * s);
    lines.push(`${d.primary ? '主屏' : '副屏'}: 逻辑 ${d.w} x ${d.h} @ ${d.freq || '—'} Hz, 缩放 ${Math.round(s * 100)}%, 物理约 ${pw} x ${ph}`);
  });
  mons.forEach(x => lines.push(`面板: ${[x.vendor, x.name || x.label].filter(Boolean).join(' ') || '—'} ${x.diagonalIn || '—'} 英寸`));

  /* ---- 内存 ---- */
  const memRows = [
    row('总容量', mem.totalGB, ' GB'),
    row('内存条数', mem.sticks, ' 条'),
    row('运行频率', mem.mhz, ' MT/s'),
    row('当前占用', num(live.memUsedGB, 1), ' GB', 'hl', 'memUsedGB')
  ];
  const modSubs = (mem.modules || []).map(x =>
    `${E(x.slot || 'DIMM')}：${E(x.manufacturer || '')} ${x.gb} GB${x.mhz ? ' @ ' + x.mhz + ' MT/s' : ''}${x.part ? ' · ' + E(x.part) : ''}`);
  cards.push(card('内存', memRows, modSubs, 'DDR 频率来自 SPD'));
  lines.push('', '[内存]', `总容量: ${mem.totalGB || '—'} GB / ${mem.sticks || '—'} 条 @ ${mem.mhz || '—'} MT/s`);

  /* ---- 存储 ---- */
  const diskRows = [];
  disks.forEach((d, i) => {
    diskRows.push(row(`磁盘 ${i + 1}`, d.model));
    diskRows.push(row('容量 / 总线', gb(d.gb), d.busType ? ` · ${BUS[d.busType] || d.interface || ''}` : ''));
    diskRows.push(row('介质', MEDIA[d.mediaType] || d.interface || null));
  });
  if (!diskRows.length) diskRows.push(row('物理磁盘', '未获取到'));
  const partSubs = parts.map(p =>
    `${E(p.drive || '')} ${E(p.label || '')} · 共 ${p.totalGB} GB，可用 ${p.freeGB} GB`);
  cards.push(card('存储', diskRows, partSubs.length ? ['分区：', ...partSubs] : [],
    `${disks.length} 块物理盘 · ${parts.length} 个分区`));
  lines.push('', '[存储]');
  disks.forEach(d => lines.push(`${d.model}: ${gb(d.gb)} ${BUS[d.busType] || ''} ${MEDIA[d.mediaType] || ''}`));

  /* ---- 电池 ---- */
  const health = (bat.fullMWh && bat.designMWh)
    ? num(bat.fullMWh / bat.designMWh * 100, 1) : null;
  const state = bat.charging ? '充电中' : (bat.powerOnline ? '已接电源' : '电池供电');
  const batRows = [
    row('电池型号', bat.name),
    row('设计容量', bat.designMWh ? num(bat.designMWh / 1000, 1) : null, ' Wh'),
    row('当前满充容量', bat.fullMWh ? num(bat.fullMWh / 1000, 1) : null, ' Wh'),
    row('电池健康度', health, ' %', 'hl'),
    row('循环次数', bat.cycle, ' 次'),
    row('当前电量', bat.chargePct, ' %', 'hl', 'batteryPct'),
    row('剩余能量', bat.remainingMWh ? num(bat.remainingMWh / 1000, 1) : null, ' Wh'),
    row('供电状态', state),
    row('充电 / 放电功率',
      (typeof bat.chargeW === 'number' || typeof bat.dischargeW === 'number') ?
        `${bat.chargeW || 0} / ${bat.dischargeW || 0}` : null, ' W')
  ];
  cards.push(card('电池与供电', batRows, [], '设计容量来自 powercfg 电池报告'));
  lines.push('', '[电池]', `设计容量: ${bat.designMWh || '—'} mWh`,
    `满充容量: ${bat.fullMWh || '—'} mWh`, `健康度: ${health || '—'}%`,
    `循环次数: ${bat.cycle || '—'}`, `当前电量: ${bat.chargePct || '—'}%`);

  /* ---- 网络 ---- */
  const netRows = [];
  nets.forEach(x => {
    netRows.push(row('网卡', x.name));
    netRows.push(row('协商速率', x.speedMbps, ' Mbps'));
    netRows.push(row('MAC 地址', x.mac));
  });
  if (!netRows.length) netRows.push(row('活动网卡', '未获取到'));
  cards.push(card('网络', netRows));
  lines.push('', '[网络]');
  nets.forEach(x => lines.push(`${x.name}: ${x.speedMbps || '—'} Mbps`));

  /* ---- 实时状态 ---- */
  const liveRows = [
    row('整机功率', num(live.powerW, 1), ' W', 'hl', 'powerW'),
    row('CPU 占用', num(live.cpuPct, 1), ' %', '', 'cpuPct'),
    row('CPU 频率', live.cpuMHz ? num(live.cpuMHz / 1000, 2) : null, ' GHz', '', 'cpuMHz'),
    row('GPU 占用', num(live.gpuPct, 1), ' %', '', 'gpuPct'),
    row('GPU 温度', num(live.gpuTempC, 0), ' °C', '', 'gpuTempC'),
    row('已用内存', num(live.memUsedGB, 1), ' GB', '', 'memUsedGB')
  ];
  cards.push(card('实时状态', liveRows, [], '取自托盘监控的当前采样'));

  $('#grid').innerHTML = cards.join('');
  $('#grid').hidden = false;
  hasData = true;
  summaryText = lines.join('\n') + `\n\n采集时间: ${time(meta.collectedAt) || '—'}`;

  const stamp = time(meta.collectedAt) || '—';
  $('#subtitle').textContent = `${modelLine || '本机'} · ${m.model || ''} · 采集于 ${stamp}`;
  if (d.fromCache) {
    $('#status').className = '';
    $('#status').textContent = '显示的是上次保存的快照，正在后台重新采集…';
  } else if (meta.ok === false) {
    $('#status').className = 'err';
    $('#status').textContent = '本次采集失败：' + (meta.error || '未知错误') + '（可点「刷新」重试）';
  } else {
    $('#status').className = '';
    $('#status').hidden = true;
  }
  setBusy(false);
}

function showError(msg) {
  $('#status').hidden = false;
  $('#status').className = 'err';
  $('#status').textContent = msg;
  setBusy(false);
}

async function load(force) {
  setBusy(true);
  try {
    const d = await window.sysinfo.get(!!force);
    if (d && d.machine) render(d);
    else if (!hasData) {
      $('#status').hidden = false;
      $('#status').className = '';
      $('#status').innerHTML = '正在读取硬件信息…<br>首次读取需要启动一次系统信息查询，可能需要十几秒；结果会缓存，之后再打开即时显示。';
    }
  } catch (e) { showError('读取失败：' + e.message); }
}

window.sysinfo.onLive(applyLive);
window.sysinfo.onData(d => {
  if (d && d.machine) render(d);
  else showError('采集失败：' + ((d && d.meta && d.meta.error) || '未知错误'));
});

$('#btnRefresh').addEventListener('click', () => load(true));
$('#btnClose').addEventListener('click', () => window.sysinfo.close());
$('#btnCopy').addEventListener('click', async () => {
  if (!summaryText) return;
  const btn = $('#btnCopy');
  try {
    await navigator.clipboard.writeText(summaryText);
    btn.textContent = '已复制';
    setTimeout(() => { btn.textContent = '复制摘要'; }, 1400);
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = summaryText; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); btn.textContent = '已复制'; } catch (_) { btn.textContent = '复制失败'; }
    ta.remove();
    setTimeout(() => { btn.textContent = '复制摘要'; }, 1400);
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') window.sysinfo.close();
});

load(false);
