# Send a command to the WebView2 SMTC session, then report the resulting status.
# Pure ASCII on purpose: PowerShell 5.1 reads UTF-8-without-BOM as GBK.
# NOTE: WinRT projection is unavailable in pwsh 7 (.NET 8), so this must run under 5.1.
param(
    [ValidateSet('toggle', 'play', 'pause', 'next', 'previous', 'status')]
    [string]$Action = 'status',
    [int]$Seconds = 5
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$managerTypeName = 'Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime'

function Await-Op($op) {
    if ($null -eq $op) { throw 'null async op' }
    # IAsyncOperation exposes Status (0=Started,1=Completed,2=Canceled,3=Error) and GetResults().
    $statusProp = $op.GetType().GetProperty('Status')
    $deadline = (Get-Date).AddSeconds(8)
    while ((Get-Date) -lt $deadline) {
        $st = $statusProp.GetValue($op)
        if ($st -ne 0) {
            if ($st -ne 1) { return "async-status=$st" }
            $getResults = $op.GetType().GetMethod('GetResults')
            if ($null -eq $getResults) { return 'completed-no-results' }
            return $getResults.Invoke($op, $null)
        }
        Start-Sleep -Milliseconds 60
    }
    return 'async-timeout'
}

function Get-Manager {
    $t = [Type]::GetType($managerTypeName)
    if ($null -eq $t) { throw 'winrt-type-not-resolved' }
    $op = $t.GetMethod('RequestAsync').Invoke($null, $null)
    $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() |
        Where-Object {
            $_.Name -eq 'AsTask' -and
            $_.GetParameters().Count -eq 1 -and
            $_.GetParameters()[0].ParameterType.IsGenericType -and
            $_.GetParameters()[0].ParameterType.GetGenericTypeDefinition().FullName -eq 'Windows.Foundation.IAsyncOperation`1'
        } | Select-Object -First 1
    $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op))
    if (-not $task.Wait(8000)) { throw 'request-timeout' }
    return $task.GetType().GetProperty('Result').GetValue($task)
}

function Get-Status($session) {
    $info = $session.GetPlaybackInfo()
    return [string]$info.GetType().GetProperty('PlaybackStatus').GetValue($info)
}

function Get-Title($session) {
    # Title is nice-to-have only; never let it break the command path.
    return ''
}

try {
    $mgr = Get-Manager
    $sessions = @($mgr.GetSessions())
    $target = $sessions | Where-Object { $_.SourceAppUserModelId -like '*webview2*' } | Select-Object -First 1
    if ($null -eq $target) {
        Write-Output 'NO_WEBVIEW2_SESSION'
        Write-Output ('all=' + (($sessions | ForEach-Object { $_.SourceAppUserModelId }) -join ','))
        exit 4
    }
    Write-Output ('TARGET ' + $target.SourceAppUserModelId)
    Write-Output ('BEFORE ' + (Get-Status $target) + ' | title=' + (Get-Title $target))

    switch ($Action) {
        'toggle'   { Write-Output ('ACTION toggle -> ' + (Await-Op $target.TryTogglePlayPauseAsync())) }
        'play'     { Write-Output ('ACTION play -> ' + (Await-Op $target.TryPlayAsync())) }
        'pause'    { Write-Output ('ACTION pause -> ' + (Await-Op $target.TryPauseAsync())) }
        'next'     { Write-Output ('ACTION next -> ' + (Await-Op $target.TrySkipNextAsync())) }
        'previous' { Write-Output ('ACTION previous -> ' + (Await-Op $target.TrySkipPreviousAsync())) }
        'status'   { Write-Output 'ACTION none' }
    }

    Start-Sleep -Seconds $Seconds
    Write-Output ('AFTER ' + (Get-Status $target) + ' | title=' + (Get-Title $target))
} catch {
    $inner = ''
    if ($null -ne $_.Exception.InnerException) { $inner = ' | inner: ' + $_.Exception.InnerException.Message }
    Write-Output ('SMTC_CTL_FAIL ' + $_.Exception.Message + $inner)
    exit 1
}
