# Check whether the deployed bundle contains the lyrics bridge code (read-only).
# Pure ASCII on purpose: PowerShell 5.1 reads UTF-8-without-BOM as GBK.
param([string]$Asset = '')
$ErrorActionPreference = 'Stop'

$wc = New-Object System.Net.WebClient
$wc.Proxy = $null
try {
    if ([string]::IsNullOrWhiteSpace($Asset)) {
        $html = $wc.DownloadString('https://music.9li.life/')
        $i = $html.IndexOf('/assets/')
        $j = $html.IndexOf('"', $i)
        $Asset = $html.Substring($i, $j - $i)
    }
    $js = $wc.DownloadString('https://music.9li.life' + $Asset)
} finally {
    $wc.Dispose()
}
Write-Output ('asset = ' + $Asset)
Write-Output ('bundle size = ' + $js.Length)

$needles = @(
    'lyrics_push_state',
    'lyrics_send_command',
    'melodex:lyrics-state',
    'melodex:lyrics-command',
    'melodex:shell-shortcut',
    'set_overlay_visible'
)
foreach ($n in $needles) {
    $hit = $js.IndexOf($n) -ge 0
    Write-Output (('{0,-24} {1}' -f $n, $(if ($hit) { 'FOUND' } else { 'MISSING' })))
}
