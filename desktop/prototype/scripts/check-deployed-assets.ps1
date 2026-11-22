# Check what the deployed site actually serves (read-only).
# Pure ASCII on purpose: PowerShell 5.1 reads UTF-8-without-BOM as GBK.
$ErrorActionPreference = 'Stop'
$wc = New-Object System.Net.WebClient
$wc.Proxy = $null
try {
    $html = $wc.DownloadString('https://music.9li.life/')
} finally {
    $wc.Dispose()
}
Write-Output ('html length = ' + $html.Length)

# Extract script/link asset paths without PowerShell regex-literal pitfalls.
$start = 0
$found = @()
while ($true) {
    $i = $html.IndexOf('/assets/', $start)
    if ($i -lt 0) { break }
    $j = $html.IndexOf('"', $i)
    if ($j -lt 0) { break }
    $found += $html.Substring($i, $j - $i)
    $start = $j
}
Write-Output '--- deployed asset paths ---'
$found | Select-Object -Unique | ForEach-Object { Write-Output $_ }
