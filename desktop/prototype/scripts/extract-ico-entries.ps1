# Extract every entry of an ICO file to separate PNGs for inspection.
# Pure ASCII on purpose: PowerShell 5.1 reads UTF-8-without-BOM as GBK.
param(
    [Parameter(Mandatory = $true)][string]$Ico,
    [Parameter(Mandatory = $true)][string]$OutDir
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

if (-not (Test-Path -LiteralPath $OutDir)) {
    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
}

$bytes = [System.IO.File]::ReadAllBytes($Ico)
$count = [System.BitConverter]::ToUInt16($bytes, 4)
Write-Output ('entries = ' + $count)

for ($i = 0; $i -lt $count; $i++) {
    $off = 6 + ($i * 16)
    $w = [int]$bytes[$off]
    $h = [int]$bytes[$off + 1]
    if ($w -eq 0) { $w = 256 }
    if ($h -eq 0) { $h = 256 }
    $dataSize = [System.BitConverter]::ToUInt32($bytes, $off + 8)
    $dataOff = [System.BitConverter]::ToUInt32($bytes, $off + 12)

    # Rebuild a single-entry ICO so System.Drawing can decode it.
    $header = New-Object byte[] (6 + 16)
    $header[0] = 0; $header[1] = 0
    $header[2] = 1; $header[3] = 0
    $header[4] = 1; $header[5] = 0
    $header[6] = $bytes[$off]
    $header[7] = $bytes[$off + 1]
    for ($k = 0; $k -lt 14; $k++) { $header[8 + $k] = $bytes[$off + 2 + $k] }
    # data offset must be 22 for the rebuilt single-entry file
    $newOff = [System.BitConverter]::GetBytes([uint32]22)
    for ($k = 0; $k -lt 4; $k++) { $header[18 + $k] = $newOff[$k] }

    $payload = New-Object byte[] $dataSize
    [System.Array]::Copy($bytes, $dataOff, $payload, 0, $dataSize)

    $combined = New-Object byte[] ($header.Length + $payload.Length)
    [System.Array]::Copy($header, 0, $combined, 0, $header.Length)
    [System.Array]::Copy($payload, 0, $combined, $header.Length, $payload.Length)

    $tmpIco = Join-Path $env:TEMP ("single-{0}.ico" -f $w)
    [System.IO.File]::WriteAllBytes($tmpIco, $combined)

    try {
        $icon = New-Object System.Drawing.Icon($tmpIco)
        $bmp = $icon.ToBitmap()
        $out = Join-Path $OutDir ("ico-{0}.png" -f $w)
        $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
        Write-Output ('  ' + $w + 'x' + $h + ' -> ' + $out + ' (decoded ' + $bmp.Width + 'x' + $bmp.Height + ')')
        $bmp.Dispose()
        $icon.Dispose()
    } catch {
        Write-Output ('  ' + $w + 'x' + $h + ' decode failed: ' + $_.Exception.Message)
    } finally {
        Remove-Item -LiteralPath $tmpIco -Force -ErrorAction SilentlyContinue
    }
}
