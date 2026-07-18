param(
    [string[]]$Tasks = @("testDebugUnitTest", "assembleDebug")
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path $PSScriptRoot).Path

if ($projectRoot -notmatch '[^\x00-\x7F]') {
    & (Join-Path $projectRoot "gradlew.bat") @Tasks
    exit $LASTEXITCODE
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
    & (Join-Path "$drive\" "gradlew.bat") @Tasks
    $exitCode = $LASTEXITCODE
}
finally {
    subst $drive /d
}
exit $exitCode
