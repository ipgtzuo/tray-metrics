'use strict';
/** 命令行自检：不开 GUI，验证本机每路数据源到底能读到什么。npm run probe */
const { Metrics, TYPES, KEYS } = require('./metrics');

const m = new Metrics();
let psErrors = '';
m.on('error', e => { psErrors += e.message + '\n'; });
m.on('ps-exit', code => { psErrors += '[采集器退出 code=' + code + ']\n'; });
m.start();

const pad = (s, n) => String(s).padEnd(n, ' ');
console.log('正在采集，约 7 秒后输出本机实测结果…\n');

setTimeout(() => {
  console.log('类型    数值        明细');
  console.log('-'.repeat(72));
  for (const k of KEYS) {
    const v = m.value(k);
    const val = v === null ? '— 无数据' : (m.display(k) + ' ' + TYPES[k].unit);
    console.log(pad(TYPES[k].name, 8) + pad(val, 12) + m.sub(k));
    m.rows(k).forEach(r => console.log('         ' + pad(r[0], 12) + (r[1] === null ? '—' : r[1])));
    if (m.reason(k)) console.log('         原因: ' + m.reason(k));
  }
  console.log('-'.repeat(72));
  console.log('数据源状态:', JSON.stringify(m.availability));
  console.log('WMI 短命采集:', '成功 ' + m.psRuns + ' 轮 / 单轮耗时 ' + m.psLastMs + ' ms');
  console.log('整机功率:', m.s.powerLabel, '| CPU封装', m.s.cpuPkgW, 'W | GPU', m.s.gpuW,
    'W | 基线', m.s.platformBaseW, 'W | RAPL', m.availability.rapl, '| 墙插', m.availability.wall);
  if (psErrors.trim()) console.log('PowerShell 诊断:\n' + psErrors.slice(0, 3000));
  console.log('任务栏浅色:', m.s.lightTaskbar);
  console.log('采集快照数:', m.hist.cpu.length);
  m.stop();
  process.exit(0);
}, 7000);
