[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-LocalPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Value,
        [Parameter(Mandatory = $true)]
        [string]$SettingName
    )

    if ([string]::IsNullOrWhiteSpace($Value) -or $Value.StartsWith('<')) {
        throw "Set '$SettingName' in run-local.config.psd1 before running the client."
    }

    $expanded = [Environment]::ExpandEnvironmentVariables($Value)
    if (-not [IO.Path]::IsPathRooted($expanded)) {
        $expanded = Join-Path $PSScriptRoot $expanded
    }
    return [IO.Path]::GetFullPath($expanded)
}

function Assert-File {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$Description
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Description was not found: $Path"
    }
}

function Invoke-Native {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Command,
        [string[]]$Arguments = @()
    )

    Write-Host ("> {0} {1}" -f $Command, ($Arguments -join ' '))
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code $LASTEXITCODE`: $Command"
    }
}

function Wait-FileUnlocked {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [int]$TimeoutSeconds = 10
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return
    }

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ($true) {
        try {
            $stream = [IO.File]::Open(
                $Path,
                [IO.FileMode]::Open,
                [IO.FileAccess]::ReadWrite,
                [IO.FileShare]::None
            )
            $stream.Dispose()
            return
        } catch [IO.IOException], [UnauthorizedAccessException] {
            if ([DateTime]::UtcNow -ge $deadline) {
                throw "Timed out waiting for the previous client to release: $Path"
            }
            Start-Sleep -Milliseconds 100
        }
    }
}

$configPath = Join-Path $PSScriptRoot 'run-local.config.psd1'
Assert-File -Path $configPath -Description 'Local runner configuration'
$config = Import-PowerShellDataFile -LiteralPath $configPath

foreach ($requiredSetting in @('QtRoot', 'PrismSdkRoot', 'VsDevShell')) {
    if (-not $config.ContainsKey($requiredSetting)) {
        throw "Missing '$requiredSetting' in run-local.config.psd1."
    }
}

$qtRoot = Resolve-LocalPath -Value ([string]$config.QtRoot) -SettingName 'QtRoot'
$configuredPrismSdkRoot = Resolve-LocalPath `
    -Value ([string]$config.PrismSdkRoot) -SettingName 'PrismSdkRoot'
$vsDevShell = Resolve-LocalPath -Value ([string]$config.VsDevShell) -SettingName 'VsDevShell'

$localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
$defaultOutputRoot = Join-Path $localAppData 'Melodex'
$buildValue = if ($config.ContainsKey('BuildDir')) {
    [string]$config.BuildDir
} else {
    Join-Path $defaultOutputRoot 'desktop-build'
}
$deployValue = if ($config.ContainsKey('DeployDir')) {
    [string]$config.DeployDir
} else {
    Join-Path $defaultOutputRoot 'desktop-deploy'
}
$buildDir = Resolve-LocalPath -Value $buildValue -SettingName 'BuildDir'
$deployDir = Resolve-LocalPath -Value $deployValue -SettingName 'DeployDir'

$pythonExe = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
$configuredPrismConfig = Join-Path `
    $configuredPrismSdkRoot 'lib\cmake\prism\prismConfig.cmake'
$configuredPrismQml = Join-Path `
    $configuredPrismSdkRoot 'share\prism\qml\PrismQML\qmldir'
$winDeployQt = Join-Path $qtRoot 'bin\windeployqt.exe'

Assert-File -Path $pythonExe -Description 'Desktop test Python'
Assert-File -Path $configuredPrismConfig -Description 'Configured PrismQML CMake package'
Assert-File -Path $configuredPrismQml -Description 'Configured PrismQML QML module'
Assert-File -Path $vsDevShell -Description 'Visual Studio developer shell'
Assert-File -Path $winDeployQt -Description 'Qt deployment tool'

$prismSdkName = Split-Path -Leaf $configuredPrismSdkRoot
$prismSdkCacheRoot = Join-Path $defaultOutputRoot 'prism-sdk-cache'
$prismSdkRoot = Join-Path $prismSdkCacheRoot $prismSdkName
New-Item -ItemType Directory -Force -Path `
    $buildDir, $deployDir, $prismSdkRoot | Out-Null

# MSVC's linker cannot reliably consume a library below a non-ASCII path.
# Keep the configured SDK as the source of truth and stage the same immutable
# SDK release into a stable ASCII LocalAppData path for both CMake and QML.
Write-Host '[Melodex] Synchronizing the configured PrismQML SDK...'
Get-ChildItem -LiteralPath $configuredPrismSdkRoot -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $prismSdkRoot `
        -Recurse -Force
}

$prismConfigDir = Join-Path $prismSdkRoot 'lib\cmake\prism'
$prismConfig = Join-Path $prismConfigDir 'prismConfig.cmake'
$prismQmlDir = Join-Path $prismSdkRoot 'share\prism\qml\PrismQML\qmldir'
Assert-File -Path $prismConfig -Description 'Staged PrismQML CMake package'
Assert-File -Path $prismQmlDir -Description 'Staged PrismQML QML module'

Write-Host '[Melodex] Loading the Visual Studio x64 developer environment...'
& $vsDevShell -Arch amd64 -HostArch amd64 -SkipAutomaticLocation

$cmake = (Get-Command cmake.exe -ErrorAction Stop).Source
$ctest = Join-Path (Split-Path -Parent $cmake) 'ctest.exe'
Assert-File -Path $ctest -Description 'CTest executable'
Get-Command nmake.exe -ErrorAction Stop | Out-Null

Push-Location $PSScriptRoot
try {
    Write-Host '[Melodex] Running Python regression tests...'
    Invoke-Native -Command $pythonExe -Arguments @(
        '-m', 'unittest', 'discover', '-s', 'tests', '-v'
    )

    Write-Host '[Melodex] Configuring and building the C++ client...'
    Invoke-Native -Command $cmake -Arguments @(
        '-S', $PSScriptRoot,
        '-B', $buildDir,
        '-G', 'NMake Makefiles',
        '-DCMAKE_BUILD_TYPE=Release',
        "-DCMAKE_PREFIX_PATH:PATH=$qtRoot",
        "-Dprism_DIR:PATH=$prismConfigDir"
    )
    Invoke-Native -Command $cmake -Arguments @('--build', $buildDir)

    Write-Host '[Melodex] Running C++ and QML tests...'
    Invoke-Native -Command $ctest -Arguments @(
        '--test-dir', $buildDir, '--output-on-failure'
    )

    $runningClients = @(Get-Process -Name 'melodex_desktop' -ErrorAction SilentlyContinue)
    if ($runningClients.Count -gt 0) {
        Write-Host '[Melodex] Stopping the previous desktop client...'
        $runningClients | Stop-Process -Force
        $runningClients | Wait-Process -Timeout 10 -ErrorAction Stop
    }

    $deployedExe = Join-Path $deployDir 'bin\melodex_desktop.exe'
    Wait-FileUnlocked -Path $deployedExe

    Write-Host '[Melodex] Installing into the stable local deployment directory...'
    Invoke-Native -Command $cmake -Arguments @(
        '--install', $buildDir, '--prefix', $deployDir, '--config', 'Release'
    )

    $deployedQmlRoot = Join-Path $deployDir 'bin\qml'
    Assert-File -Path $deployedExe -Description 'Installed Melodex client'

    Invoke-Native -Command $winDeployQt -Arguments @(
        '--release',
        '--compiler-runtime',
        '--no-system-dxc-compiler',
        '--qmldir', (Join-Path $PSScriptRoot 'qml'),
        '--qmlimport', $deployedQmlRoot,
        '--qml-deploy-dir', $deployedQmlRoot,
        $deployedExe
    )

    # A stale session override can silently load a different PrismQML runtime.
    Remove-Item Env:PRISMQML_QML_DIR -ErrorAction SilentlyContinue
    Write-Host '[Melodex] Starting the client...'
    $client = Start-Process -FilePath $deployedExe `
        -WorkingDirectory (Split-Path -Parent $deployedExe) -PassThru
    Start-Sleep -Milliseconds 1200
    $client.Refresh()
    if ($client.HasExited) {
        throw "Melodex exited during startup with code $($client.ExitCode)."
    }

    Write-Host "[Melodex] Client started. PID=$($client.Id)"
    Write-Host "[Melodex] Executable: $deployedExe"
} finally {
    Pop-Location
}
