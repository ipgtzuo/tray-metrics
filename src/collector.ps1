# 单次采集脚本：Node 每 10 秒以 -EncodedCommand 启动一次，输出一行 DATA:{json} 后立即退出。
# 相比常驻进程省掉约 150 MB 常驻内存；网速由 Node 侧 netstat -e 每 2 秒差分负责，
# 这里只补变化慢的变量，所以 10 秒刷新一次不影响体感。
param([switch]$Once)   # 兼容旧自检调用；单次模式下无实际作用

$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'   # 不关会把进度记录写进 stderr
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

function Get-ActiveAdapterName {
  $r = Get-NetRoute -DestinationPrefix '0.0.0.0/0' |
       Where-Object { $_.NextHop -ne '0.0.0.0' } |
       Sort-Object { [int]$_.RouteMetric + [int]$_.InterfaceMetric } |
       Select-Object -First 1
  if ($r) {
    $a = Get-NetAdapter -InterfaceIndex $r.ifIndex
    if ($a) { return $a.Name }
  }
  $u = Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and $_.Virtual -eq $false } | Select-Object -First 1
  if ($u) { return $u.Name }
  return $null
}

function Get-TaskbarLight {
  $p = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -Name SystemUsesLightTheme
  return ($p.SystemUsesLightTheme -eq 1)
}

$o = [ordered]@{}

# 活动网卡名仅用于展示、变化极慢，且这组 cmdlet 要加载 NetTCPIP/NetAdapter 模块（冷启动最贵的一步）。
# Node 侧每 6 轮（约 60 秒）才让本脚本查一次，其余轮次跳过，单次耗时可降一半以上。
if ($env:TM_SKIP_ADAPTER -ne '1') {
  $adapterName = Get-ActiveAdapterName
  if ($adapterName) { $o.netAdapter = $adapterName }
}

# 内存（WMI 口径比 os.freemem 准确，不含缓存误判）
$os = Get-CimInstance Win32_OperatingSystem
if ($os) {
  $o.memTotalKB = [double]$os.TotalVisibleMemorySize
  $o.memFreeKB = [double]$os.FreePhysicalMemory
}

# 磁盘 C: 占用与读写速率
$d = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
if ($d -and $d.Size -gt 0) {
  $o.diskPct = [math]::Round(100 * (1 - $d.FreeSpace / $d.Size), 1)
  $o.diskTotalGB = [math]::Round($d.Size / 1GB, 1)
}
$pd = Get-CimInstance Win32_PerfFormattedData_PerfDisk_LogicalDisk -Filter "Name='C:'"
if ($pd) {
  $o.diskReadMB = [math]::Round([double]$pd.DiskReadBytesPersec / 1MB, 2)
  $o.diskWriteMB = [math]::Round([double]$pd.DiskWriteBytesPersec / 1MB, 2)
}

# 电池放电功率（仅笔记本）
$bs = Get-CimInstance -Namespace root\wmi -ClassName BatteryStatus
if ($bs) {
  $o.batteryW = [math]::Round([double]$bs.DischargeRate / 1000, 1)
  $o.powerOnline = [bool]$bs.PowerOnline
}

# CPU 当前频率
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
if ($cpu) { $o.cpuMHz = [double]$cpu.CurrentClockSpeed }

# 任务栏深浅（决定托盘前景色）
$o.lightTaskbar = Get-TaskbarLight

Write-Output ('DATA:' + ($o | ConvertTo-Json -Compress -Depth 4))
[Console]::Out.Flush()
