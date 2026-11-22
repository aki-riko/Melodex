# Inspect multi-resolution ICO entries (read-only).
# Pure ASCII on purpose: PowerShell 5.1 reads UTF-8-without-BOM as GBK.
param([string]$Path = '')
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($Path)) { throw 'Path is required' }
if (-not (Test-Path -LiteralPath $Path)) { throw "not found: $Path" }

$bytes = [System.IO.File]::ReadAllBytes($Path)
Write-Output ('file = ' + $Path)
Write-Output ('size = ' + $bytes.Length + ' bytes')
if ($bytes.Length -lt 6) { throw 'too small to be an ICO' }

$reserved = [System.BitConverter]::ToUInt16($bytes, 0)
$type = [System.BitConverter]::ToUInt16($bytes, 2)
$count = [System.BitConverter]::ToUInt16($bytes, 4)
Write-Output ('reserved=' + $reserved + ' type=' + $type + ' imageCount=' + $count)

if ($type -ne 1) { throw 'not an ICO file' }

# ICONDIRENTRY is 16 bytes starting at offset 6.
for ($i = 0; $i -lt $count; $i++) {
    $off = 6 + ($i * 16)
    $w = [int]$bytes[$off]
    $h = [int]$bytes[$off + 1]
    if ($w -eq 0) { $w = 256 }
    if ($h -eq 0) { $h = 256 }
    $bpp = [System.BitConverter]::ToUInt16($bytes, $off + 6)
    $size = [System.BitConverter]::ToUInt32($bytes, $off + 8)
    Write-Output (('  entry {0}: {1}x{2} {3}bpp dataSize={4}' -f $i, $w, $h, $bpp, $size))
}
