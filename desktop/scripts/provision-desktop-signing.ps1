# 为 Desktop Release workflow 配置 Tauri 更新签名 secrets。
#
# 设计原则（与 provision-release-signing.ps1 一致）：
#   密钥值只在本进程内存里流转，**不打印、不回显、不落盘、不经过对话记录**。
#   上传完成后立刻清空变量。
#
# 用法：
#   pwsh -NoProfile -File desktop\scripts\provision-desktop-signing.ps1 `
#     -Repository aki-riko/Melodex `
#     -KeyDir '\\nas\path\to\signing'

param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern("^[^/]+/[^/]+$")]
    [string]$Repository,

    [string]$KeyDir = $env:MELODEX_TAURI_SIGNING_DIR
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if (-not $KeyDir) {
    throw "未指定签名材料目录：请设置 MELODEX_TAURI_SIGNING_DIR 或用 -KeyDir 传入。"
}

$keyFile = Join-Path $KeyDir '.tauri-updater-key'
$pwdFile = Join-Path $KeyDir '.tauri-updater-password'
$pubFile = Join-Path $KeyDir '.tauri-updater-key.pub'

foreach ($f in @($keyFile, $pwdFile, $pubFile)) {
    if (-not (Test-Path -LiteralPath $f)) {
        throw "签名材料缺失: $f"
    }
}

& gh auth status | Out-Null
if ($LASTEXITCODE -ne 0) { throw "GitHub CLI 未登录。" }

# 用临时文件传值给 gh（避免值出现在命令行参数里被进程列表看到）。
# 临时文件写完上传成功后立即用等长零字节覆盖再删除。
$tmpDir = [IO.Path]::GetTempPath()
function Set-RepoSecret([string]$Name, [string]$FilePath) {
    $tmp = Join-Path $tmpDir (".secret-" + [Guid]::NewGuid().ToString("N") + ".tmp")
    try {
        # gh secret set 从文件读值：--body-file 只用于 token，secrets 用重定向
        $value = [IO.File]::ReadAllText($FilePath)
        [IO.File]::WriteAllText($tmp, $value, [Text.UTF8Encoding]::new($false))
        $value = $null
        Get-Content -LiteralPath $tmp -Raw | & gh secret set $Name --repo $Repository
        if ($LASTEXITCODE -ne 0) { throw "写入 GitHub Secret 失败: $Name" }
    }
    finally {
        if (Test-Path -LiteralPath $tmp) {
            $len = (Get-Item -LiteralPath $tmp).Length
            if ($len -gt 0) { [IO.File]::WriteAllBytes($tmp, [byte[]]::new($len)) }
            Remove-Item -LiteralPath $tmp -Force
        }
    }
}

Set-RepoSecret "TAURI_SIGNING_PRIVATE_KEY" $keyFile
Set-RepoSecret "TAURI_SIGNING_PRIVATE_KEY_PASSWORD" $pwdFile

# 公钥不上传 secret —— 它本来就在 tauri.conf.json 里（公开信息）。
# 这里只做一致性校验：配置里的 pubkey 必须与私钥配对，否则更新器会拒绝安装。
$confPath = Join-Path $PSScriptRoot "..\src-tauri\tauri.conf.json"
$conf = Get-Content -LiteralPath $confPath -Raw | ConvertFrom-Json
$confPub = $conf.plugins.updater.pubkey
$filePub = (Get-Content -LiteralPath $pubFile -Raw).Trim()

if ($confPub -ne $filePub) {
    Write-Warning "tauri.conf.json 的公钥与签名材料目录中的公钥不一致！"
    Write-Warning "更新器会拒绝安装本密钥签出的包。请核对 $pubFile"
} else {
    Write-Host "公钥一致性校验通过（tauri.conf.json 与签名材料匹配）"
}

Write-Host "Desktop 更新签名已配置。"
Write-Host "已写入 secrets: TAURI_SIGNING_PRIVATE_KEY / TAURI_SIGNING_PRIVATE_KEY_PASSWORD"
