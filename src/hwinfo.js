'use strict';
/*
 * 系统硬件信息采集（主进程）。与 metrics.js 的常驻轮询分开：
 * 硬件信息变化极慢，只在用户打开「系统信息」窗口时采一次，结果缓存 5 分钟。
 * 采集走一次短命 PowerShell（-EncodedCommand，绕开脚本执行策略）+ 一次 nvidia-smi，
 * 全部使用 Windows 自带接口，普通权限可读、不联网、不需要第三方软件。
 */
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CACHE_MS = 5 * 60 * 1000;
/* 冷启动的 PowerShell 子进程在本机实测可能接近 20 秒（WMI 首次连接 + 模块加载），
 * 稳态只要 3 秒左右。超时给足，且首屏用磁盘缓存秒开，不让用户干等。 */
const PS_TIMEOUT_MS = 45000;
const DEBUG = !!process.env.TM_HWINFO_DEBUG;   // 开发诊断：打印采集子进程的输出与耗时
let cached = null, cachedAt = 0, inFlight = null, encodedScript = null;
let cacheDir = os.tmpdir();

function setCacheDir(dir) { cacheDir = dir || os.tmpdir(); }
function cachePath() { return path.join(cacheDir, 'hwinfo-cache.json'); }

/** 同步取缓存（内存或上次落盘结果），不会触发采集；用于窗口首屏立即渲染。 */
function peek() {
  if (cached) return cached;
  try {
    const j = JSON.parse(fs.readFileSync(cachePath(), 'utf8'));
    if (j && j.meta && j.machine) {
      cached = j;
      cachedAt = 0;   // 磁盘缓存只用于秒开，后台仍会重新采集刷新
      return j;
    }
  } catch (_) {}
  return null;
}

function persist(value) {
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cachePath(), JSON.stringify(value));
  } catch (_) {}
}

function encoded() {
  if (encodedScript) return encodedScript;
  let script = fs.readFileSync(path.join(__dirname, 'hwinfo.ps1'), 'utf8');
  if (script.charCodeAt(0) === 0xFEFF) script = script.slice(1);
  encodedScript = Buffer.from(script, 'utf16le').toString('base64');
  return encodedScript;
}

function runPowerShell() {
  return new Promise((resolve, reject) => {
    let out = '', err = '', done = false, child;
    const started = Date.now();
    try {
      child = spawn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded()],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { reject(new Error('PowerShell 启动失败: ' + e.message)); return; }

    const finish = (e, data) => {
      if (done) return;
      done = true; clearTimeout(timer);
      e ? reject(e) : resolve(data);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      finish(new Error('硬件信息采集超时'));
    }, PS_TIMEOUT_MS);

    child.stdout.on('data', d => {
      out += d.toString('utf8');
      if (DEBUG) process.stderr.write('[hwinfo:out] ' + d.toString('utf8'));
    });
    child.stderr.on('data', d => {
      err += d.toString('utf8');
      if (DEBUG) process.stderr.write('[hwinfo:err] ' + d.toString('utf8'));
    });
    child.on('error', e => finish(new Error('PowerShell 启动失败: ' + e.message)));
    child.on('close', code => {
      if (DEBUG) console.error(`[hwinfo] ps exit=${code} in ${Date.now() - started}ms stdout=${out.length}B stderr=${err.length}B`);
      const line = out.split(/\r?\n/).find(l => l.trim().startsWith('DATA:'));
      if (!line) {
        finish(new Error('未收到采集结果' + (err.trim() ? '：' + err.trim().slice(0, 160) : '')));
        return;
      }
      try { finish(null, JSON.parse(line.trim().slice(5))); }
      catch (e) { finish(new Error('采集结果解析失败: ' + e.message)); }
    });
  });
}

// WMI 的 AdapterRAM 是 32 位，8GB 显存会被截断；用 nvidia-smi 补真实显存与 VBIOS
function nvidiaStatic() {
  return new Promise(resolve => {
    execFile('nvidia-smi',
      ['--query-gpu=name,memory.total,driver_version,vbios_version,clocks.max.sm',
       '--format=csv,noheader,nounits'],
      { windowsHide: true, timeout: 5000, encoding: 'utf8', maxBuffer: 64 * 1024 },
      (err, stdout) => {
        if (err || !stdout) return resolve(null);
        const p = stdout.trim().split(/\r?\n/)[0].split(',').map(s => s.trim());
        if (p.length < 4) return resolve(null);
        resolve({
          name: p[0], vramMiB: Number(p[1]) || null, driver: p[2],
          vbios: p[3], maxClocksMHz: Number(p[4]) || null
        });
      });
  });
}

/** 返回硬件信息对象；force=true 时忽略缓存重新采集。任一路失败只影响对应字段。 */
function collect(force = false) {
  if (!force && cached && Date.now() - cachedAt < CACHE_MS) return Promise.resolve(cached);
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const [wmi, nv] = await Promise.all([
      runPowerShell().then(v => ({ ok: true, value: v })).catch(e => ({ ok: false, error: e.message })),
      nvidiaStatic()
    ]);
    const value = wmi.ok ? wmi.value : {};
    value.nvidia = nv;
    value.meta = {
      ok: wmi.ok,
      error: wmi.ok ? null : wmi.error,
      collectedAt: new Date().toISOString()
    };
    if (wmi.ok) {
      cached = value; cachedAt = Date.now();
      value.meta.cachedAtMs = cachedAt;
      persist(value);
    }
    return value;
  })().finally(() => { inFlight = null; });
  return inFlight;
}

module.exports = {
  collect, peek, setCacheDir,
  invalidate: () => { cached = null; cachedAt = 0; }
};
