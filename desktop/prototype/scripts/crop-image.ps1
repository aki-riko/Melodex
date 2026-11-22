# Crop a region of an image to inspect it closely (read-only source, writes a PNG copy).
# Pure ASCII on purpose: PowerShell 5.1 reads UTF-8-without-BOM as GBK.
param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Out,
    [int]$X = 0,
    [int]$Y = 0,
    [int]$W = 0,
    [int]$H = 0,
    [int]$Scale = 1
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$src = [System.Drawing.Image]::FromFile($Source)
try {
    if ($W -le 0) { $W = $src.Width - $X }
    if ($H -le 0) { $H = $src.Height - $Y }
    $dstW = [int]($W * $Scale)
    $dstH = [int]($H * $Scale)
    $bmp = New-Object System.Drawing.Bitmap($dstW, $dstH)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
    $destRect = New-Object System.Drawing.Rectangle(0, 0, $dstW, $dstH)
    $srcRect = New-Object System.Drawing.Rectangle($X, $Y, $W, $H)
    $g.DrawImage($src, $destRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
    $g.Dispose()
    $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Output ('wrote ' + $Out + ' (' + $dstW + 'x' + $dstH + ')')
} finally {
    $src.Dispose()
}
