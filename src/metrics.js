'use strict';
/**
 * 采集层。
 * 设计原则：每路数据源独立探测、独立降级。
 *   - 纯 Node 主路径（os / fs.statfs / netstat / nvidia-smi）：零依赖，2 秒刷新，无常驻进程
 *   - PowerShell 增强（WMI 慢变量）：每 10 秒启动一次短命进程，取完数据立即退出，不常驻内存
 *   - LibreHardwareMonitor HTTP :8085：CPU 温度 / 风扇 / 封装功耗（可选）
 * 任一路失败只让对应指标显示「—」，不影响其它指标刷新。
 */
const { EventEmitter } = require('events');
const { spawn, execFile } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

const HISTORY = 60;
const PS_INTERVAL_MS = 10000;   // WMI 慢变量采集周期
const PS_TIMEOUT_MS = 8000;     // 单次 PowerShell 硬超时，防止进程堆积
const POWER_INTERVAL_MS = 5000; // Windows Energy Meter / Power Meter 计数器采样周期
const MB = 1024 * 1024, GB = 1024 * 1024 * 1024;

const TYPES = {
  net:   { name: '网速', abbr: 'NET', color: '#7fb3ff', unit: 'MB/s', source: 'netstat -e · 累计字节时间戳差分' },
  power: { name: '整机功率', abbr: 'PWR', color: '#5dcaa5', unit: 'W', source: 'RAPL / Power Meter / nvidia-smi · 实测优先' },
  cpu:   { name: 'CPU',  abbr: 'CPU', color: '#a78bfa', unit: '%',    source: 'os.cpus() · 两次采样差分' },
  mem:   { name: '内存', abbr: 'MEM', color: '#1d9e75', unit: '%',    source: 'os.totalmem / os.freemem · 2 秒刷新' },
  disk:  { name: '磁盘', abbr: 'DSK', color: '#ef9f27', unit: '%',    source: 'fs.statfs / WMI · 占用 2 秒 / 速率 10 秒' },
  temp:  { name: '温度', abbr: 'TMP', color: '#f0784a', unit: '°C',   source: 'LHM :8085 / nvidia-smi' },
  gpu:   { name: 'GPU',  abbr: 'GPU', color: '#d4537e', unit: '%',    source: 'LHM GPU Core / nvidia-smi' }
};
const KEYS = Object.keys(TYPES);

const NA = {
  temp:  '未读到任何温度：启动 LibreHardwareMonitor 并开启 Web Server (8085)，或确认 NVIDIA 驱动可用',
  gpu:   '未读到 GPU 数据：需 LHM 或 nvidia-smi',
  power: '未读到功耗数据：需 Windows Energy Meter (Intel RAPL) 或 NVIDIA 驱动；墙插功率需智能插座',
  net:   '未读到网卡统计：netstat 与 WMI 均不可用',
  disk:  '未读到磁盘信息',
  mem:   '未读到内存信息',
  cpu:   '未读到 CPU 信息'
};

function walk(node, out) {
  if (Array.isArray(node)) { node.forEach(n => walk(n, out)); return; }
  if (!node || typeof node !== 'object') return;
  if (node.Value !== undefined && node.Text !== undefined) out.push(node);
  if (node.Children) walk(node.Children, out);
}
function num(v) {
  if (v === null || v === undefined) return null;
  const m = String(v).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}
function pick(list, ...patterns) {
  for (const re of patterns) {
    const hit = list.find(x => re.test(String(x.Text || '')));
    if (hit) return num(hit.Value);
  }
  return null;
}

class Metrics extends EventEmitter {
  constructor() {
    super();
    this.hist = {}; KEYS.forEach(k => this.hist[k] = []);
    this.availability = { lhm: false, nvidia: false, wmi: false, netstat: false, net: false, rapl: false, wall: false };
    this.s = {
      netDownMB: null, netUpMB: null, netAdapter: null, sessionGB: 0, netSource: null,
      powerW: null, powerLabel: '—', cpuPkgW: null, gpuW: null,
      raplPkgW: null, batteryWholeW: null, wallW: null, onBattery: false, powerOnline: null,
      platformBaseW: 12, sysPowerMeasured: false,
      cpuPct: null, cpuMHz: null, cpuCores: os.cpus().length,
      memPct: null, memUsedGB: null, memFreeGB: null, memTotalGB: null,
      diskPct: null, diskTotalGB: null, diskReadMB: null, diskWriteMB: null, diskTempC: null,
      tempC: null, gpuTempC: null, fanRpm: null, gpuPct: null, gpuMemGB: null,
      batteryW: null, batteryPct: null,
      lightTaskbar: null   // null = WMI 未提供，由主进程用系统主题推断
    };
    // GPU 数据分离存放：LHM 与 nvidia-smi 各一路，互不覆盖、互不清空
    this.srcLhm = { temp: null, gpuTemp: null, gpuLoad: null, gpuW: null, cpuPkgW: null, fan: null, diskTemp: null };
    this.srcNv = { gpuTemp: null, gpuLoad: null, gpuMemGB: null, gpuW: null };

    // WMI 短命采集状态：this.ps 非空表示当前有一轮正在执行
    this.ps = null; this.lastPsAt = 0; this._psScript = null; this._stopped = false;
    this.psRuns = 0; this.psLastMs = null;   // WMI 短命采集的成功轮数 / 单轮耗时
    this.lastNetstatSample = null; this.startNetstatRecv = null;
    this.lastCpu = this._cpuTimes();
    this.lhmFails = 0; this.updatedAt = null;
    this._timer = this._localTimer = this._lhmTimer = this._nvTimer = this._psTimer = this._powerTimer = null;
    this.wallUrl = null; this._wallBusy = false;
  }

  _cpuTimes() {
    let idle = 0, total = 0;
    for (const c of os.cpus()) {
      for (const k in c.times) total += c.times[k];
      idle += c.times.idle;
    }
    return { idle, total };
  }

  start() {
    this._stopped = false;
    this._sampleLocal();                       // 立即出一次数据，不用等 2 秒
    this._startPowerShell();                   // 立即跑一次 WMI，之后每 10 秒
    this._pollLHM();
    this._probeNvidia();
    this._samplePower();
    this._timer = setInterval(() => this._tick(), 1000);
    this._localTimer = setInterval(() => this._sampleLocal(), 2000);
    this._lhmTimer = setInterval(() => this._pollLHM(), 2000);
    this._nvTimer = setInterval(() => this._probeNvidia(true), 5000);
    this._powerTimer = setInterval(() => this._samplePower(), POWER_INTERVAL_MS);
  }

  stop() {
    this._stopped = true;
    [this._timer, this._localTimer, this._lhmTimer, this._nvTimer, this._psTimer, this._powerTimer].forEach(clearInterval);
    if (this.ps) { try { this.ps.kill(); } catch (_) {} this.ps = null; }
  }

  /** 菜单里的「重新检测传感器」：立刻补跑一轮 WMI，不用等下个 10 秒 */
  refreshSensors() {
    this.lhmFails = 0;
    this._pollLHM();
    this._probeNvidia(true);
    this._samplePower();
    this._runPowerShellOnce();
  }

  /* ---------------- 纯 Node 主路径（2 秒刷新） ---------------- */
  _sampleLocal() {
    // 磁盘占用：statfs 比 WMI 轻，且不需要 PowerShell
    try {
      const st = fs.statfsSync('C:\\');
      if (st.blocks > 0) {
        this.s.diskPct = 100 * (1 - st.bfree / st.blocks);
        this.s.diskTotalGB = (st.blocks * st.bsize) / GB;
      }
    } catch (_) {}
    // 内存：走纯 Node，保持 2 秒刷新；WMI 10 秒周期不该拖慢图标数字
    this.s.memTotalGB = os.totalmem() / GB;
    this.s.memFreeGB = os.freemem() / GB;
    this.s.memUsedGB = this.s.memTotalGB - this.s.memFreeGB;
    this.s.memPct = (this.s.memUsedGB / this.s.memTotalGB) * 100;
    // CPU 频率：WMI 未提供时用 os.cpus() 的读数
    if (this.s.cpuMHz === null) {
      const c = os.cpus()[0];
      if (c && c.speed) this.s.cpuMHz = c.speed;
    }

    // 网速：netstat -e 给出全接口累计字节，两次采样用真实时间戳做差
    execFile('netstat', ['-e'],
      { windowsHide: true, timeout: 3000, encoding: 'buffer', maxBuffer: 256 * 1024 },
      (err, stdout) => {
        if (err || !stdout) return;
        const lines = Buffer.isBuffer(stdout) ? stdout.toString('latin1').split(/\r?\n/) : String(stdout).split(/\r?\n/);
        let recv = null, sent = null;
        for (const line of lines) {
          const m = line.match(/(\d{3,})\s+(\d{3,})/);
          if (m) { recv = Number(m[1]); sent = Number(m[2]); break; }
        }
        if (recv === null) return;
        this.availability.netstat = true;
        if (this.startNetstatRecv === null) this.startNetstatRecv = recv;
        const now = Date.now();
        if (this.lastNetstatSample) {
          const dt = (now - this.lastNetstatSample.t) / 1000;
          if (dt > 0.2 && recv >= this.lastNetstatSample.recv && sent >= this.lastNetstatSample.sent) {
            this.s.netDownMB = ((recv - this.lastNetstatSample.recv) / dt) / MB;
            this.s.netUpMB = ((sent - this.lastNetstatSample.sent) / dt) / MB;
            this.s.sessionGB = Math.max(0, (recv - this.startNetstatRecv) / GB);
            this.s.netSource = 'netstat';
            if (!this.s.netAdapter) this.s.netAdapter = '全接口合计';
            this.availability.net = true;
          }
        }
        this.lastNetstatSample = { t: now, recv, sent };
      });
  }

  /* ---------------- 整机功率（Windows 原生 Energy Meter / Power Meter） ---------------- */
  setWallPowerUrl(url) {
    this.wallUrl = typeof url === 'string' && /^https?:\/\//.test(url) ? url : null;
  }
  setPlatformBase(w) {
    if (Number.isFinite(w) && w >= 3 && w <= 40) this.s.platformBaseW = w;
  }

  /**
   * typeperf 是 Windows 自带的轻量 PDH 工具（无常驻进程、不需要管理员、不需要 LHM）。
   * \Energy Meter(RAPL_Package0_PKG)\Power = Intel RAPL 的 CPU 封装实测功耗（mW）
   * \Power Meter(Power Meter (0))\Power   = 电池供电时的整机实测功耗（mW），接 AC 时为 0
   */
  _samplePower() {
    execFile('typeperf',
      ['\\Energy Meter(*)\\Power', '\\Power Meter(*)\\Power', '-sc', '1'],
      { windowsHide: true, timeout: 6000, encoding: 'buffer', maxBuffer: 256 * 1024 },
      (err, stdout) => {
        if (err || !stdout) { this.availability.rapl = false; this._pollWall(); return; }
        const txt = Buffer.isBuffer(stdout) ? stdout.toString('latin1') : String(stdout);
        const lines = txt.split(/\r?\n/).filter(l => l.trim());
        const head = lines.find(l => l.startsWith('"(PDH'));
        const data = lines.find(l => /^"\d/.test(l));
        if (!head || !data) { this.availability.rapl = false; this._pollWall(); return; }
        const cols = head.split(',').map(x => x.replace(/^"|"$/g, '').trim());
        const vals = data.split(',').map(x => x.replace(/^"|"$/g, '').trim());
        let pkgMW = null, pmMW = null;
        cols.forEach((c, i) => {
          const v = parseFloat(vals[i]);
          if (!Number.isFinite(v) || v <= 0) return;
          if (c.includes('RAPL_Package0_PKG') && c.endsWith('\\Power')) pkgMW = v;
          else if (c.includes('Power Meter(') && c.endsWith('\\Power')) pmMW = Math.max(pmMW || 0, v);
        });
        this.s.raplPkgW = pkgMW !== null ? pkgMW / 1000 : null;
        this.availability.rapl = pkgMW !== null;
        this.s.batteryWholeW = pmMW !== null ? pmMW / 1000 : null;
        this.s.onBattery = pmMW !== null;
        this._resolvePower();
        this._pollWall();
      });
  }

  /** 可选：智能插座 / PMBus 电源等能给出真实墙插功率的 HTTP 端点 */
  async _pollWall() {
    if (!this.wallUrl || this._wallBusy) return;
    this._wallBusy = true;
    try {
      const r = await fetch(this.wallUrl, { signal: AbortSignal.timeout(1500) });
      const j = await r.json();
      const v = typeof j === 'number' ? j : (j.power ?? j.power_w ?? j.watts ?? null);
      const n = Number(v);
      this.s.wallW = Number.isFinite(n) && n > 0 ? n : null;
    } catch (_) {
      this.s.wallW = null;
    }
    this.availability.wall = this.s.wallW !== null;
    this._wallBusy = false;
    this._resolvePower();
  }

  /* ---------------- PowerShell 增强（每 10 秒短命进程） ---------------- */
  _startPowerShell() {
    this._psTimer = setInterval(() => this._runPowerShellOnce(), PS_INTERVAL_MS);
    this._runPowerShellOnce();
  }

  _encodedScript() {
    if (this._psScript) return this._psScript;
    // 以 -EncodedCommand 传入脚本内容：很多机器禁止运行 .ps1 文件，
    // 但命令行传入的命令不受「脚本文件执行策略」限制，也无需 Bypass 提权。
    const script = fs.readFileSync(path.join(__dirname, 'collector.ps1'), 'utf8');
    this._psScript = Buffer.from(script, 'utf16le').toString('base64');
    return this._psScript;
  }

  _runPowerShellOnce() {
    if (this._stopped || this.ps) return;   // 上一轮未结束就跳过，绝不堆叠进程
    let encoded;
    try { encoded = this._encodedScript(); }
    catch (e) { this.emit('error', new Error('读取采集脚本失败: ' + e.message)); return; }

    // 活动网卡名每 6 轮（约 60 秒）查一次；其余轮次让脚本跳过最贵的模块加载
    const needAdapter = this.psRuns % 6 === 0 || !this.s.netAdapter;
    let child;
    try {
      child = spawn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, TM_SKIP_ADAPTER: needAdapter ? '0' : '1' } });
    } catch (e) {
      this.emit('error', new Error('PowerShell 启动失败: ' + e.message));
      return;
    }
    this.ps = child;
    const t0 = Date.now();
    let out = '', err = '', finished = false, gotData = false;
    const timer = setTimeout(() => {
      if (finished) return;
      try { child.kill(); } catch (_) {}
      finish('timeout');
    }, PS_TIMEOUT_MS);

    const finish = reason => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (this.ps === child) this.ps = null;
      this.psLastMs = Date.now() - t0;
      const line = out.split(/\r?\n/).map(x => x.trim()).filter(x => x.startsWith('DATA:')).pop();
      if (line) { gotData = true; this.psRuns++; this._onPsData(line.slice(5)); }
      if (err.trim()) this._onStderr(err);
      // 正常退出且拿到数据不算异常；只有超时/启动失败/空结果才通知上层
      if (!gotData && !this._stopped) this.emit('ps-exit', reason);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', d => { out += d; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => {
      this.emit('error', new Error('PowerShell 采集器: ' + e.message));
      finish('error');
    });
    child.on('close', () => finish('close'));
  }

  /** PowerShell 的 stderr 主要是 CLIXML 进度流；只把真正的 <S S="Error"> 当错误上报 */
  _onStderr(txt) {
    const raw = String(txt || '').trim();
    if (!raw || raw === '#< CLIXML') return;
    const errs = [...raw.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map(m => m[1]);
    if (errs.length) {
      this.emit('error', new Error('PowerShell: ' + errs.join(' | ').slice(0, 200)));
      return;
    }
    if (!/^[<#]/.test(raw) && !/<\/?Objs|<\/?Obj|<\/?S\b/.test(raw)) {
      this.emit('error', new Error('PowerShell: ' + raw.slice(0, 200)));
    }
  }

  _onPsData(json) {
    let d;
    try { d = JSON.parse(json); } catch (_) { return; }
    this.availability.wmi = true;
    this.lastPsAt = Date.now();
    const s = this.s;

    // 网速不在这里算：netstat 每 2 秒差分；WMI 只补活动网卡名
    if (d.netAdapter) s.netAdapter = d.netAdapter;

    if (typeof d.diskPct === 'number') s.diskPct = d.diskPct;
    if (typeof d.diskTotalGB === 'number') s.diskTotalGB = d.diskTotalGB;
    if (typeof d.diskReadMB === 'number') s.diskReadMB = d.diskReadMB;
    if (typeof d.diskWriteMB === 'number') s.diskWriteMB = d.diskWriteMB;
    if (typeof d.cpuMHz === 'number' && d.cpuMHz > 0) s.cpuMHz = d.cpuMHz;
    if (typeof d.batteryW === 'number') {
      s.batteryW = d.batteryW;
      s.batteryPct = d.batteryPct ?? null;
    }
    if (typeof d.powerOnline === 'boolean') s.powerOnline = d.powerOnline;
    if (typeof d.lightTaskbar === 'boolean') s.lightTaskbar = d.lightTaskbar;

    this._resolvePower();
  }

  /* ---------------- 可选传感器 ---------------- */
  async _pollLHM() {
    if (this.lhmFails > 2 && this.lhmFails % 8 !== 0) { this.lhmFails++; return; }
    try {
      const res = await fetch('http://127.0.0.1:8085/data.json', { signal: AbortSignal.timeout(1500) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const all = []; walk(await res.json(), all);
      const ofType = t => all.filter(x => String(x.Type || '').toLowerCase() === t);
      const temps = ofType('temperature'), loads = ofType('load'),
            powers = ofType('power'), fans = ofType('fan');
      this.srcLhm = {
        temp: pick(temps, /cpu package/i, /core max/i, /cpu/i),
        gpuTemp: pick(temps, /gpu core/i, /gpu/i),
        diskTemp: pick(temps, /ssd|hdd|nvme|disk/i),
        gpuLoad: pick(loads, /gpu core/i, /gpu/i),
        gpuW: pick(powers, /gpu package|gpu power|gpu core/i),
        cpuPkgW: pick(powers, /cpu package/i, /cpu/i),
        fan: pick(fans, /cpu fan|cpu/i, /.*/)
      };
      this.availability.lhm = true;
      this.lhmFails = 0;
    } catch (_) {
      this.availability.lhm = false;
      this.lhmFails++;
      this.srcLhm = { temp: null, gpuTemp: null, gpuLoad: null, gpuW: null, cpuPkgW: null, fan: null, diskTemp: null };
    }
    this._mergeSensors();
  }

  _probeNvidia() {
    execFile('nvidia-smi',
      ['--query-gpu=utilization.gpu,temperature.gpu,memory.used,power.draw', '--format=csv,noheader,nounits'],
      { windowsHide: true, timeout: 2500 }, (err, stdout) => {
        if (err || !stdout) { this.srcNv = { gpuTemp: null, gpuLoad: null, gpuMemGB: null, gpuW: null }; }
        else {
          const p = stdout.trim().split('\n')[0].split(',').map(x => num(x.trim()));
          this.srcNv = {
            gpuLoad: p[0], gpuTemp: p[1],
            gpuMemGB: p[2] !== null && p[2] !== undefined ? p[2] / 1024 : null,
            gpuW: p[3]
          };
          this.availability.nvidia = !!(p[0] !== null || p[1] !== null);
        }
        this._mergeSensors();
      });
  }

  /** 多路传感器合并：LHM 优先，nvidia-smi 回退 */
  _mergeSensors() {
    const L = this.srcLhm, N = this.srcNv, s = this.s;
    s.tempC = L.temp;
    s.gpuTempC = L.gpuTemp ?? N.gpuTemp;
    s.diskTempC = L.diskTemp;
    s.gpuPct = L.gpuLoad ?? N.gpuLoad;
    s.gpuMemGB = N.gpuMemGB;
    s.gpuW = L.gpuW ?? N.gpuW;
    s.cpuPkgW = L.cpuPkgW ?? s.raplPkgW;   // LHM 优先，否则用 Windows RAPL 实测
    s.fanRpm = L.fan;
    this._resolvePower();
  }

  /** 整机总功率分层：墙插实测 > 电池整机实测 > 实测 CPU/GPU + 基线估算 > 无数据 */
  _resolvePower() {
    const s = this.s;
    const cpuW = this.srcLhm.cpuPkgW ?? s.raplPkgW;
    const gpuW = typeof s.gpuW === 'number' ? s.gpuW : null;
    s.cpuPkgW = cpuW;

    // 1) 墙插实测（智能插座 / PMBus）：AC 侧真值，优先级最高
    if (typeof s.wallW === 'number' && s.wallW > 0) {
      s.powerW = s.wallW; s.powerLabel = '墙插实测 · 外接电表'; s.sysPowerMeasured = true;
      return;
    }
    // 2) 电池供电：Power Meter / 放电率 = 整机 DC 侧实测，并用它反推平台基线
    const onBattery = s.onBattery || s.powerOnline === false;
    const whole = s.batteryWholeW ??
      (onBattery && typeof s.batteryW === 'number' && s.batteryW > 0 ? s.batteryW : null);
    if (whole !== null && whole > 0) {
      s.powerW = whole; s.powerLabel = '整机实测 · 电池供电'; s.sysPowerMeasured = true;
      if (cpuW !== null && gpuW !== null) {
        const b = whole - cpuW - gpuW;
        if (b >= 3 && b <= 40 && Math.abs(b - s.platformBaseW) > 0.5) {
          s.platformBaseW = b;
          this.emit('baseline', b);   // 主进程持久化，下次启动仍用校准过的基线
        }
      }
      return;
    }
    // 3) 接 AC 且无外接电表：CPU/GPU 是实测，屏幕/内存/主板等用基线估算
    if (cpuW !== null || gpuW !== null) {
      s.powerW = (cpuW || 0) + (gpuW || 0) + s.platformBaseW;
      s.powerLabel = cpuW !== null && gpuW !== null ? '整机估算 · CPU/GPU 实测' : '整机估算 · 部分实测';
      s.sysPowerMeasured = false;
      return;
    }
    s.powerW = null; s.powerLabel = '无可用功耗源'; s.sysPowerMeasured = false;
  }

  _tick() {
    const s = this.s, now = Date.now();
    const cur = this._cpuTimes();
    const dTotal = cur.total - this.lastCpu.total, dIdle = cur.idle - this.lastCpu.idle;
    if (dTotal > 0) s.cpuPct = Math.max(0, Math.min(100, 100 * (1 - dIdle / dTotal)));
    this.lastCpu = cur;
    // 连续 3 个周期没拿到 WMI 数据就标记为不可用
    if (this.availability.wmi && now - this.lastPsAt > PS_INTERVAL_MS * 3) this.availability.wmi = false;

    KEYS.forEach(k => {
      const v = this.value(k), arr = this.hist[k];
      arr.push(v === null ? (arr.length ? arr[arr.length - 1] : 0) : v);
      if (arr.length > HISTORY) arr.shift();
    });
    this.updatedAt = now;
    this.emit('tick');
  }

  /* ---------------- 对外读取 ---------------- */
  value(key) {
    const s = this.s;
    switch (key) {
      case 'net':   return s.netDownMB;
      case 'power': return s.powerW;
      case 'cpu':   return s.cpuPct;
      case 'mem':   return s.memPct;
      case 'disk':  return s.diskPct;
      case 'temp':  return s.tempC ?? s.gpuTempC;  // CPU 温度缺失时退到 GPU 温度，并在说明里标出
      case 'gpu':   return s.gpuPct;
      default: return null;
    }
  }
  /** 托盘图标数值：最多 4 字符 */
  text(key) {
    const v = this.value(key);
    if (v === null || !Number.isFinite(v)) return '--';
    // 托盘图标只有 24px 物理尺寸，带小数的值会被横向压小；≥10 时取整以放大字号，
    // 详情面板仍用 display() 展示完整小数。
    if (key === 'net' || key === 'power') {
      if (v >= 10) return String(Math.round(v)).slice(0, 4);
      return v.toFixed(1).slice(0, 4);
    }
    return String(Math.round(v)).slice(0, 4);
  }
  display(key) {
    const v = this.value(key);
    if (v === null || !Number.isFinite(v)) return '—';
    if (key === 'net' || key === 'power') return v >= 100 ? String(Math.round(v)) : v.toFixed(1);
    return String(Math.round(v));
  }
  sub(key) {
    const s = this.s;
    switch (key) {
      case 'net':   return '下行 · ' + (s.netAdapter || '全接口合计') + ' · netstat 差分';
      case 'power': return s.powerLabel;
      case 'cpu':   return s.cpuCores + ' 逻辑核 · ' + (s.cpuMHz ? (s.cpuMHz / 1000).toFixed(1) + ' GHz' : '频率未知');
      case 'mem':   return s.memUsedGB !== null ? s.memUsedGB.toFixed(1) + ' / ' + s.memTotalGB.toFixed(1) + ' GB' : '—';
      case 'disk':  return 'C: · ' + (s.diskTotalGB ? s.diskTotalGB.toFixed(0) + ' GB' : '容量未知');
      case 'temp':  return s.tempC !== null
        ? 'CPU 封装' + (s.fanRpm ? ' · 风扇 ' + Math.round(s.fanRpm) + ' RPM' : '')
        : (s.gpuTempC !== null ? 'GPU 核心温度（nvidia-smi）' : '—');
      case 'gpu':   return s.gpuTempC !== null ? '核心温度 ' + Math.round(s.gpuTempC) + ' °C' : 'GPU';
      default: return '';
    }
  }
  rows(key) {
    const s = this.s,
          f1 = v => (v === null || v === undefined) ? null : Number(v).toFixed(1),
          r0 = v => (v === null || v === undefined) ? null : String(Math.round(v));
    switch (key) {
      case 'net': return [
        ['下行速度', s.netDownMB === null ? null : f1(s.netDownMB) + ' MB/s'],
        ['上行速度', s.netUpMB === null ? null : f1(s.netUpMB) + ' MB/s'],
        ['本次会话', s.sessionGB.toFixed(2) + ' GB'],
        ['采集来源', 'netstat 差分' + (s.netAdapter ? ' · ' + s.netAdapter : '')]
      ];
      case 'power': return [
        ['整机总功率', s.powerW === null ? null : f1(s.powerW) + ' W · ' + (s.sysPowerMeasured ? '实测' : '估算')],
        ['CPU 封装', s.cpuPkgW === null ? null : f1(s.cpuPkgW) + ' W · RAPL'],
        ['GPU 功耗', s.gpuW === null ? null : f1(s.gpuW) + ' W · NV'],
        ['平台基线', f1(s.platformBaseW) + ' W · 其余部件']
      ];
      case 'cpu': return [
        ['当前占用', r0(s.cpuPct) === null ? null : r0(s.cpuPct) + ' %'],
        ['当前频率', s.cpuMHz === null ? null : (s.cpuMHz / 1000).toFixed(2) + ' GHz'],
        ['逻辑处理器', String(s.cpuCores) + ' 核'],
        ['数据来源', 'os.cpus() 差分']
      ];
      case 'mem': return [
        ['已用', s.memUsedGB === null ? null : s.memUsedGB.toFixed(1) + ' GB'],
        ['可用', s.memFreeGB === null ? null : s.memFreeGB.toFixed(1) + ' GB'],
        ['总量', s.memTotalGB === null ? null : s.memTotalGB.toFixed(1) + ' GB'],
        ['占用率', r0(s.memPct) === null ? null : r0(s.memPct) + ' %']
      ];
      case 'disk': return [
        ['C: 占用', r0(s.diskPct) === null ? null : r0(s.diskPct) + ' %'],
        ['读取速度', s.diskReadMB === null ? null : s.diskReadMB.toFixed(1) + ' MB/s'],
        ['写入速度', s.diskWriteMB === null ? null : s.diskWriteMB.toFixed(1) + ' MB/s'],
        ['硬盘温度', s.diskTempC === null ? null : Math.round(s.diskTempC) + ' °C']
      ];
      case 'temp': return [
        ['CPU 封装', r0(s.tempC) === null ? null : r0(s.tempC) + ' °C'],
        ['GPU 核心', r0(s.gpuTempC) === null ? null : r0(s.gpuTempC) + ' °C'],
        ['固态硬盘', r0(s.diskTempC) === null ? null : r0(s.diskTempC) + ' °C'],
        ['CPU 风扇', r0(s.fanRpm) === null ? null : r0(s.fanRpm) + ' RPM']
      ];
      case 'gpu': return [
        ['核心占用', r0(s.gpuPct) === null ? null : r0(s.gpuPct) + ' %'],
        ['核心温度', r0(s.gpuTempC) === null ? null : r0(s.gpuTempC) + ' °C'],
        ['显存占用', s.gpuMemGB === null ? null : s.gpuMemGB.toFixed(1) + ' GB'],
        ['GPU 功耗', s.gpuW === null ? null : s.gpuW.toFixed(1) + ' W']
      ];
      default: return [];
    }
  }
  /** 补充说明：既解释「无数据」，也解释「数据来源被降级」 */
  reason(key) {
    const s = this.s;
    if (this.value(key) === null) return NA[key] || null;
    if (key === 'temp' && s.tempC === null && s.gpuTempC !== null)
      return '当前显示 GPU 核心温度；CPU / 硬盘 / 风扇需 LHM 开启 Web Server (8085)';
    if (key === 'power') {
      if (s.powerLabel.startsWith('墙插实测')) return '外接电表 AC 侧实测，已含电源适配器损耗。';
      if (s.powerLabel.startsWith('整机实测')) return '电池供电 · Windows Power Meter 整机 DC 实测，已据此校准平台基线。';
      return '估算 = CPU 封装 + GPU + 平台基线 ' + s.platformBaseW.toFixed(1) +
        ' W（屏幕/内存/主板/风扇）。墙插 AC 功率需智能插座：在 config.json 配 wallPowerUrl 即可接入。';
    }
    if (key === 'net' && s.netSource === 'netstat')
      return 'netstat -e 累计字节按真实时间戳差分（2 秒刷新）；虚拟网卡 / VPN 开启时可能偏高';
    if (key === 'disk')
      return '占用率每 2 秒刷新（fs.statfs）；读写速率为 WMI 瞬时值，每 10 秒刷新';
    return null;
  }

  /** 一次性序列化全量数据，IPC 只传纯对象（不能带函数） */
  snapshot() {
    const types = KEYS.map(k => ({
      key: k, name: TYPES[k].name, abbr: TYPES[k].abbr, color: TYPES[k].color,
      unit: TYPES[k].unit, display: this.display(k), iconText: this.text(k),
      sub: this.sub(k), source: TYPES[k].source, rows: this.rows(k),
      hist: this.hist[k].slice(), reason: this.reason(k),
      available: this.value(k) !== null
    }));
    return {
      types, updatedAt: this.updatedAt, lightTaskbar: this.s.lightTaskbar,
      availability: { ...this.availability, wmiRuns: this.psRuns, wmiLastMs: this.psLastMs }
    };
  }
}

module.exports = { Metrics, TYPES, KEYS, HISTORY };
