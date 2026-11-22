# SMTC probe: list current Windows media sessions (read-only).
# Run with Windows PowerShell 5.1: powershell.exe -NoProfile -ExecutionPolicy Bypass -File smtc-probe.ps1
# NOTE: keep this file pure ASCII. PowerShell 5.1 reads UTF-8-without-BOM as GBK and will fail to parse.
# NOTE: WinRT projection is unavailable in pwsh 7 (.NET 8), so this must run under 5.1.
param(
    [switch]$Watch,
    [int]$Seconds = 20,
    [string]$Expect = ''
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$managerTypeName = 'Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime'

function Get-Manager {
    $t = [Type]::GetType($managerTypeName)
    if ($null -eq $t) { throw 'winrt-type-not-resolved' }
    $op = $t.GetMethod('RequestAsync').Invoke($null, $null)
    if ($null -eq $op) { throw 'request-async-null' }
    $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() |
        Where-Object {
            $_.Name -eq 'AsTask' -and
            $_.GetParameters().Count -eq 1 -and
            $_.GetParameters()[0].ParameterType.IsGenericType -and
            $_.GetParameters()[0].ParameterType.GetGenericTypeDefinition().FullName -eq 'Windows.Foundation.IAsyncOperation`1'
        } | Select-Object -First 1
    if ($null -eq $asTask) { throw 'as-task-not-found' }
    $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op))
    if (-not $task.Wait(8000)) { throw 'request-timeout' }
    return $task.GetType().GetProperty('Result').GetValue($task)
}

function Get-Rows($manager) {
    $sessions = $manager.GetType().GetMethod('GetSessions').Invoke($manager, $null)
    $rows = @()
    foreach ($s in $sessions) {
        $aumid = [string]$s.GetType().GetProperty('SourceAppUserModelId').GetValue($s)
        $status = 'unknown'
        $title = ''
        try {
            $info = $s.GetPlaybackInfo()
            $status = [string]$info.GetType().GetProperty('PlaybackStatus').GetValue($info)
        } catch { }
        try {
            $props = $s.TryGetMediaPropertiesAsync().GetResults()
            $title = [string]$props.Title
        } catch { }
        $rows += [pscustomobject]@{ Aumid = $aumid; Status = $status; Title = $title }
    }
    return $rows
}

try {
    $mgr = Get-Manager
    Write-Output 'SMTC_OK'
    $rows = @(Get-Rows $mgr)
    Write-Output ('sessions=' + $rows.Count)
    foreach ($r in $rows) { Write-Output ('  aumid=' + $r.Aumid + ' status=' + $r.Status + ' title=' + $r.Title) }

    if ($Watch) {
        Write-Output '--- watching ---'
        $deadline = (Get-Date).AddSeconds($Seconds)
        $seen = $false
        while ((Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds 600
            $now = @(Get-Rows $mgr)
            $line = ($now | ForEach-Object { $_.Aumid + ':' + $_.Status }) -join ' | '
            Write-Output ('t=' + (Get-Date).ToString('HH:mm:ss') + ' n=' + $now.Count + ' ' + $line)
            if ($Expect -ne '') {
                if (@($now | Where-Object { $_.Aumid -like ('*' + $Expect + '*') }).Count -gt 0) { $seen = $true }
            } else {
                if ($now.Count -gt 0) { $seen = $true }
            }
        }
        if ($seen) { Write-Output 'WATCH_RESULT=SEEN' } else { Write-Output 'WATCH_RESULT=NOT_SEEN' }
    }
} catch {
    $inner = ''
    if ($null -ne $_.Exception.InnerException) { $inner = ' | inner: ' + $_.Exception.InnerException.Message }
    Write-Output ('SMTC_FAIL ' + $_.Exception.Message + $inner)
    exit 1
}
