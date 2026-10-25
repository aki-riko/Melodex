param(
  [string]$Exe = "$env:TEMP\melodex-base.exe",
  [string]$Label = "baseline",
  [int]$Port = 18329,
  [int]$Runs = 5
)

# 「我的歌单」加载耗时基准:desktop 模式(免登录)起真实二进制,对生产同量级数据库
# 反复请求 /music/collections/<id>/songs,报告每次耗时与中位数。
# 用法: pwsh -File .bench/bench.ps1 -Exe <exe> -Label baseline

$ErrorActionPreference = 'Stop'
$bench = "C:\Users\Kotori\AppData\Local\Temp\melobench"
$db = "$bench\data\settings.db"
$env:MUSIC_DL_CONFIG_DB = $db
$env:MUSIC_DL_DOWNLOAD_DIR = "$bench\downloads"
New-Item -ItemType Directory -Force -Path "$bench\downloads" | Out-Null

$logOut = "$bench\$Label.out.log"
$logErr = "$bench\$Label.err.log"
$proc = Start-Process -FilePath $Exe `
  -ArgumentList 'web', '--port', "$Port", '--no-browser', '--desktop' `
  -PassThru -RedirectStandardOutput $logOut -RedirectStandardError $logErr -WindowStyle Hidden

try {
  $ready = $false
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    try {
      $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/v1/healthz" -TimeoutSec 2 -UseBasicParsing
      if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch { }
  }
  if (-not $ready) {
    Write-Host "server failed to start; stderr:"
    Get-Content $logErr -ErrorAction SilentlyContinue | Select-Object -Last 30
    throw "server not ready"
  }

  # 预热一次(进程内索引/缓存构建属于首次成本,单独标注)
  $null = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/music/collections/11/songs" -TimeoutSec 60 -UseBasicParsing

  $targets = @(
    @{ Id = 11; Songs = 19; Missing = 0 },
    @{ Id = 7; Songs = 43; Missing = 8 },
    @{ Id = 8; Songs = 99; Missing = 15 },
    @{ Id = 10; Songs = 163; Missing = 43 }
  )

  $results = @()
  foreach ($t in $targets) {
    $times = @()
    $bytes = 0
    for ($n = 0; $n -lt $Runs; $n++) {
      $sw = [System.Diagnostics.Stopwatch]::StartNew()
      $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/music/collections/$($t.Id)/songs" -TimeoutSec 120 -UseBasicParsing
      $sw.Stop()
      $times += $sw.Elapsed.TotalMilliseconds
      $bytes = $resp.RawContentLength
    }
    $sorted = $times | Sort-Object
    $median = $sorted[[int][math]::Floor($sorted.Count / 2)]
    $results += [pscustomobject]@{
      Collection = $t.Id
      Songs      = $t.Songs
      Missing    = $t.Missing
      Median_ms  = [math]::Round($median, 1)
      Min_ms     = [math]::Round($sorted[0], 1)
      Max_ms     = [math]::Round($sorted[-1], 1)
      Bytes      = $bytes
    }
  }

  Write-Host ""
  Write-Host "=== $Label ==="
  $results | Format-Table -AutoSize | Out-String | Write-Host
  $results | ConvertTo-Json -Depth 4 | Set-Content "$bench\$Label.json"
}
finally {
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
}
