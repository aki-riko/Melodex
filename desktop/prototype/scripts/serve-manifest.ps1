# Serve a local updater manifest for end-to-end verification (read-only test fixture).
# Pure ASCII on purpose: PowerShell 5.1 reads UTF-8-without-BOM as GBK.
# NOTE: HttpListener instead of TcpListener so we do not hand-roll HTTP framing.
param(
    [int]$Port = 47900,
    [string]$ManifestPath = '',
    [int]$Seconds = 120
)
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($ManifestPath)) { throw 'ManifestPath is required' }
if (-not (Test-Path -LiteralPath $ManifestPath)) { throw "manifest not found: $ManifestPath" }
$body = [System.IO.File]::ReadAllText($ManifestPath)

$listener = New-Object System.Net.HttpListener
$prefix = "http://127.0.0.1:$Port/"
$listener.Prefixes.Add($prefix)
try {
    $listener.Start()
} catch {
    Write-Output ('listener start failed: ' + $_.Exception.Message)
    exit 1
}
Write-Output ('serving on ' + $prefix)

$deadline = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $deadline) {
    # Always start a fresh context request; do not reuse a cancelled task.
    $task = $listener.GetContextAsync()
    while (-not $task.AsyncWaitHandle.WaitOne(500)) {
        if ((Get-Date) -ge $deadline) { break }
    }
    if (-not $task.AsyncWaitHandle.WaitOne(0)) { break }
    try {
        $ctx = $task.GetAwaiter().GetResult()
    } catch {
        Write-Output ('context error: ' + $_.Exception.Message)
        break
    }
    try {
        $path = $ctx.Request.Url.AbsolutePath
        Write-Output ('request ' + $ctx.Request.HttpMethod + ' ' + $path)
        if ($path -eq '/latest.json') {
            $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
            $ctx.Response.StatusCode = 200
            $ctx.Response.ContentType = 'application/json'
            $ctx.Response.ContentLength64 = $bytes.Length
            $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
        } else {
            $msg = [System.Text.Encoding]::UTF8.GetBytes('not found')
            $ctx.Response.StatusCode = 404
            $ctx.Response.ContentLength64 = $msg.Length
            $ctx.Response.OutputStream.Write($msg, 0, $msg.Length)
        }
    } catch {
        Write-Output ('handler error: ' + $_.Exception.Message)
    } finally {
        try { $ctx.Response.Close() } catch { }
    }
}
try { $listener.Stop() } catch { }
Write-Output 'listener stopped'
