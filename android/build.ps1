param(
    [string[]]$Tasks = @("testDebugUnitTest", "assembleDebug")
)

$ErrorActionPreference = "Stop"
$androidRoot = (Resolve-Path $PSScriptRoot).Path
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

if ($env:MELODEX_JAVA_HOME) {
    $env:JAVA_HOME = $env:MELODEX_JAVA_HOME
}

function Invoke-AndroidBuild([string]$root, [string]$android) {
    if (-not (Test-Path (Join-Path $root "node_modules\@capacitor\android"))) {
        throw "缺少根目录 Capacitor 依赖，请先在仓库根目录运行 npm.cmd install"
    }
    Push-Location $root
    try {
        & npm.cmd run cap:copy
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    finally {
        Pop-Location
    }
    & (Join-Path $android "gradlew.bat") -p $android @Tasks
    exit $LASTEXITCODE
}

if ($projectRoot -notmatch '[^\x00-\x7F]') {
    Invoke-AndroidBuild $projectRoot $androidRoot
}

$usedDriveNames = @(Get-PSDrive -PSProvider FileSystem | ForEach-Object Name)
$driveName = (90..68 | ForEach-Object { [char]$_ } | Where-Object { $_ -notin $usedDriveNames } | Select-Object -First 1)
if (-not $driveName) {
    throw "没有可用于 Android 构建的临时盘符"
}

$drive = "${driveName}:"
subst $drive $projectRoot
$exitCode = 1
try {
    $mappedRoot = "$drive\"
    $mappedAndroid = Join-Path $mappedRoot "android"
    if (-not (Test-Path (Join-Path $mappedRoot "node_modules\@capacitor\android"))) {
        throw "缺少根目录 Capacitor 依赖，请先在仓库根目录运行 npm.cmd install"
    }
    Push-Location $mappedRoot
    try {
        & npm.cmd run cap:copy
        if ($LASTEXITCODE -ne 0) { throw "Capacitor 资源同步失败" }
    }
    finally {
        Pop-Location
    }
    & (Join-Path $mappedAndroid "gradlew.bat") -p $mappedAndroid @Tasks
    $exitCode = $LASTEXITCODE
}
finally {
    subst $drive /d
}
exit $exitCode
