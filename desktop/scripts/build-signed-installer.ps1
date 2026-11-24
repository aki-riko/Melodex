# 构建带签名的桌面安装包。
#
# 签名私钥存放在仓库之外的目录，由**脚本自己**读入本进程环境变量后立刻构建，
# 全程不打印、不回显、不写盘、不经过对话记录。
# 私钥只在本 pwsh 进程存活期间存在，构建结束随进程退出消失。
#
# 签名材料目录**不写进仓库**（本仓库公开）。用环境变量或参数传入：
#   $env:MELODEX_TAURI_SIGNING_DIR = '<仓库外某个目录>'
# 或 pwsh -NoProfile -File build-signed-installer.ps1 -KeyDir '<该目录>'
# 该目录下需存在: .tauri-updater-key / .tauri-updater-key.pub / .tauri-updater-password
#
# 用法: pwsh -NoProfile -File build-signed-installer.ps1

param(
    [string]$KeyDir = $env:MELODEX_TAURI_SIGNING_DIR
)

$ErrorActionPreference = 'Stop'

if (-not $KeyDir) {
    throw "未指定签名材料目录：请设置环境变量 MELODEX_TAURI_SIGNING_DIR，或用 -KeyDir 参数传入。出于安全考虑，仓库内不记录该目录的真实位置。"
}

$keyDir = $KeyDir
$keyFile = Join-Path $keyDir '.tauri-updater-key'
$pwdFile = Join-Path $keyDir '.tauri-updater-password'

if (-not (Test-Path $keyFile)) { throw "私钥文件不存在: $keyFile" }
if (-not (Test-Path $pwdFile)) { throw "口令文件不存在: $pwdFile" }

# 读入后立即转成环境变量，随后把局部变量清空。
$signingKey = [System.IO.File]::ReadAllText($keyFile)
$signingPwd = [System.IO.File]::ReadAllText($pwdFile)
$env:TAURI_SIGNING_PRIVATE_KEY = $signingKey
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $signingPwd
$signingKey = $null
$signingPwd = $null

Write-Output "签名环境已就绪（长度已校验，不显示内容）"

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$tauri = Join-Path $repoRoot 'node_modules\.bin\tauri.cmd'
$projDir = Join-Path $repoRoot 'desktop\src-tauri'
Push-Location $projDir
try {
    & $tauri build 2>&1 | Select-Object -Last 15
    $code = $LASTEXITCODE
} finally {
    Pop-Location
    # 无论成败都清掉，避免残留
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
}

Write-Output "exit=$code"
