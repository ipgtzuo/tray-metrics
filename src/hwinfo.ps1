# 系统硬件信息采集：主进程以 -EncodedCommand 单次调用，输出一行 DATA:{json} 后退出。
# 全部使用 Windows 自带 WMI/CIM + powercfg，普通权限即可读取，不需要管理员、不联网。
# 参考 LenovoLegionToolkit 公开的硬件接口事实（机型/BIOS/显示器 EDID/GPU 字段），未复制其代码。
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$sw = [Diagnostics.Stopwatch]::StartNew()
function Stamp($s) {
  if ($env:TM_HWINFO_STAGE -eq '1') { [Console]::Error.WriteLine('STAGE ' + $s + ' ' + $sw.ElapsedMilliseconds + 'ms') }
}

function Edid-Text($bytes) {
  if (-not $bytes) { return $null }
  $chars = @()
  foreach ($b in $bytes) {
    $n = [int]$b
    if ($n -ge 32 -and $n -le 126) { $chars += [char]$n }
  }
  $s = (-join $chars).Trim()
  if ($s.Length -eq 0) { return $null }
  return $s
}
function As-Num($v) {
  if ($null -eq $v) { return $null }
  return [double]$v
}

$o = [ordered]@{}

# ---- 整机 / 主板 / BIOS / 操作系统 ----
try {
  $cs = Get-CimInstance Win32_ComputerSystem
  $bios = Get-CimInstance Win32_BIOS
  $bb = Get-CimInstance Win32_BaseBoard
  $oss = Get-CimInstance Win32_OperatingSystem
  $biosDate = $null
  if ($bios -and $bios.ReleaseDate) { $biosDate = $bios.ReleaseDate.ToString('yyyy-MM-dd') }
  $bootTime = $null
  if ($oss -and $oss.LastBootUpTime) { $bootTime = $oss.LastBootUpTime.ToString('yyyy-MM-dd HH:mm:ss') }
  $o.machine = [ordered]@{
    manufacturer = [string]$cs.Manufacturer
    model        = [string]$cs.Model
    family       = [string]$cs.SystemFamily
    sku          = [string]$cs.SystemSKUNumber
    bios         = [string]$bios.SMBIOSBIOSVersion
    biosDate     = $biosDate
    board        = [string]$bb.Product
    os           = [string]$oss.Caption
    osBuild      = [string]$oss.BuildNumber
    osArch       = [string]$oss.OSArchitecture
    bootTime     = $bootTime
    hypervisor   = [bool]$cs.HypervisorPresent
    pcType       = As-Num $cs.PCSystemType
  }
} catch { }

# ---- 处理器 ----
try {
  $p = Get-CimInstance Win32_Processor | Select-Object -First 1
  if ($p) {
    $o.cpu = [ordered]@{
      name      = ([string]$p.Name).Trim()
      cores     = As-Num $p.NumberOfCores
      threads   = As-Num $p.NumberOfLogicalProcessors
      baseMHz   = As-Num $p.MaxClockSpeed
      l2KB      = As-Num $p.L2CacheSize
      l3KB      = As-Num $p.L3CacheSize
      socket    = [string]$p.SocketDesignation
      vtEnabled = [bool]$p.VirtualizationFirmwareEnabled
    }
  }
} catch { }

# ---- 显卡（过滤虚拟显示器适配器）----
try {
  $list = @()
  foreach ($g in @(Get-CimInstance Win32_VideoController)) {
    $n = [string]$g.Name
    if ($n -match 'Virtual|Todesk|ToDesk|GameViewer|Mirror|Indirect|Remote') { continue }
    $list += [ordered]@{
      name       = $n
      processor  = [string]$g.VideoProcessor
      driver     = [string]$g.DriverVersion
      driverDate = if ($g.DriverDate) { $g.DriverDate.ToString('yyyy-MM-dd') } else { $null }
      vramBytes  = As-Num $g.AdapterRAM
      width      = As-Num $g.CurrentHorizontalResolution
      height     = As-Num $g.CurrentVerticalResolution
      refresh    = As-Num $g.CurrentRefreshRate
      maxRefresh = As-Num $g.MaxRefreshRate
      status     = [string]$g.Status
    }
  }
  $o.gpus = $list
} catch { }

# ---- 内存 ----
try {
  $mods = @(Get-CimInstance Win32_PhysicalMemory)
  $totalGB = 0.0
  $speed = $null
  $items = @()
  foreach ($m in $mods) {
    $gb = [math]::Round([double]$m.Capacity / 1GB, 1)
    $totalGB += $gb
    if (-not $speed) { $speed = As-Num $m.ConfiguredClockSpeed }
    if (-not $speed) { $speed = As-Num $m.Speed }
    $items += [ordered]@{
      manufacturer = ([string]$m.Manufacturer).Trim()
      gb           = $gb
      mhz          = As-Num $m.ConfiguredClockSpeed
      part         = ([string]$m.PartNumber).Trim()
      slot         = [string]$m.DeviceLocator
    }
  }
  $o.memory = [ordered]@{ totalGB = [math]::Round($totalGB, 1); sticks = $mods.Count; mhz = $speed; modules = $items }
} catch { }

# ---- 物理磁盘 / 分区 ----
try {
  $phys = @(Get-CimInstance -Namespace root\Microsoft\Windows\Storage -ClassName MSFT_PhysicalDisk)
  $disks = @()
  foreach ($d in @(Get-CimInstance Win32_DiskDrive)) {
    $model = [string]$d.Model
    $matched = $null
    foreach ($q in $phys) {
      $fn = [string]$q.FriendlyName
      if ($fn -and $model -and ($model -like ('*' + $fn + '*') -or $fn -like ('*' + $model + '*'))) { $matched = $q; break }
    }
    $disks += [ordered]@{
      model     = $model.Trim()
      gb        = [math]::Round([double]$d.Size / 1GB, 1)
      interface = [string]$d.InterfaceType
      mediaType = As-Num $matched.MediaType
      busType   = As-Num $matched.BusType
    }
  }
  $o.disks = $disks
  $parts = @()
  foreach ($l in @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3')) {
    $parts += [ordered]@{
      drive = [string]$l.DeviceID
      totalGB = [math]::Round([double]$l.Size / 1GB, 1)
      freeGB  = [math]::Round([double]$l.FreeSpace / 1GB, 1)
      label   = [string]$l.VolumeName
    }
  }
  $o.partitions = $parts
} catch { }

# ---- 显示器 EDID（厂商、型号、生产周、物理尺寸）----
try {
  $params = @(Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorBasicDisplayParams)
  $desktop = @(Get-CimInstance Win32_DesktopMonitor)
  $mons = @()
  foreach ($e in @(Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorID)) {
    $key = [string]$e.InstanceName
    $p = $null
    foreach ($q in $params) { if ([string]$q.InstanceName -eq $key) { $p = $q; break } }
    $w = 0.0; $h = 0.0
    if ($p) { $w = [double]$p.MaxHorizontalImageSize; $h = [double]$p.MaxVerticalImageSize }
    $diag = $null
    if ($w -gt 0 -and $h -gt 0) { $diag = [math]::Round([math]::Sqrt($w * $w + $h * $h) / 2.54, 1) }
    $d = $null
    foreach ($q in $desktop) {
      $pn = [string]$q.PNPDeviceID
      if ($pn -and $key.StartsWith($pn)) { $d = $q; break }
    }
    $mons += [ordered]@{
      vendor     = Edid-Text $e.ManufacturerName
      name       = Edid-Text $e.UserFriendlyName
      label      = [string]$d.MonitorType
      year       = As-Num $e.YearOfManufacture
      week       = As-Num $e.WeekOfManufacture
      widthCm    = $w
      heightCm   = $h
      diagonalIn = $diag
      resW       = As-Num $d.ScreenWidth
      resH       = As-Num $d.ScreenHeight
      pnp        = $key
    }
  }
  $o.monitors = $mons
} catch { }

# ---- 活动物理网卡 ----
try {
  $nets = @()
  foreach ($n in @(Get-CimInstance Win32_NetworkAdapter -Filter 'NetEnabled=true AND PhysicalAdapter=true')) {
    $nets += [ordered]@{
      name      = [string]$n.Name
      speedMbps = [math]::Round([double]$n.Speed / 1000000, 0)
      mac       = [string]$n.MACAddress
    }
  }
  $o.network = $nets
} catch { }

# ---- 电池：循环次数、满充/设计容量、当前状态 ----
try {
  $cyc = Get-CimInstance -Namespace root\wmi -ClassName BatteryCycleCount | Select-Object -First 1
  $full = Get-CimInstance -Namespace root\wmi -ClassName BatteryFullChargedCapacity | Select-Object -First 1
  $bs = Get-CimInstance -Namespace root\wmi -ClassName BatteryStatus | Select-Object -First 1
  $wb = Get-CimInstance Win32_Battery | Select-Object -First 1

  # 设计容量只存在于电池报告里；写临时 XML 后立刻删除，普通权限可读
  $design = $null
  try {
    $tmp = Join-Path $env:TEMP ('tm-hwinfo-battery-' + $PID + '.xml')
    powercfg /batteryreport /output $tmp /xml | Out-Null
    if (Test-Path $tmp) {
      $x = Get-Content $tmp -Raw
      $m = [regex]::Match($x, '<DesignCapacity>(\d+)</DesignCapacity>')
      if ($m.Success) { $design = [double]$m.Groups[1].Value }
      Remove-Item $tmp -Force
    }
  } catch { }

  $o.battery = [ordered]@{
    name          = [string]$wb.Name
    cycle         = As-Num $cyc.CycleCount
    designMWh     = $design
    fullMWh       = As-Num $full.FullChargedCapacity
    remainingMWh  = As-Num $bs.RemainingCapacity
    chargePct     = As-Num $wb.EstimatedChargeRemaining
    powerOnline   = [bool]$bs.PowerOnline
    charging      = [bool]$bs.Charging
    chargeW       = [math]::Round([double]$bs.ChargeRate / 1000, 1)
    dischargeW    = [math]::Round([double]$bs.DischargeRate / 1000, 1)
  }
} catch { }

Write-Output ('DATA:' + ($o | ConvertTo-Json -Compress -Depth 6))
