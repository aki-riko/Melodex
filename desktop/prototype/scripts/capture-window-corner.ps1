# Capture the top-left corner of a window by title (read-only screenshot).
# Pure ASCII on purpose: PowerShell 5.1 reads UTF-8-without-BOM as GBK.
param(
    [string]$Title = 'Melodex',
    [Parameter(Mandatory = $true)][string]$Out,
    [int]$Width = 320,
    [int]$Height = 60,
    [int]$Scale = 4,
    [int]$OffsetX = 0,
    [int]$OffsetY = 0
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$src = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class WinFinder {
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
    public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int c);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    public static IntPtr FindVisible(string title) {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr h, IntPtr l) {
            if (!IsWindowVisible(h)) return true;
            int n = GetWindowTextLength(h);
            var sb = new StringBuilder(n + 2);
            GetWindowText(h, sb, sb.Capacity);
            if (sb.ToString() == title) { found = h; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
'@
Add-Type -TypeDefinition $src -Language CSharp

$hwnd = [WinFinder]::FindVisible($Title)
if ($hwnd -eq [IntPtr]::Zero) { Write-Output ('window not found: ' + $Title); exit 4 }

[void][WinFinder]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 600

$rect = New-Object WinFinder+RECT
[void][WinFinder]::GetWindowRect($hwnd, [ref]$rect)
Write-Output ('rect=' + $rect.Left + ',' + $rect.Top + ' ' + ($rect.Right - $rect.Left) + 'x' + ($rect.Bottom - $rect.Top))

$bmp = New-Object System.Drawing.Bitmap($Width, $Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(($rect.Left + $OffsetX), ($rect.Top + $OffsetY), 0, 0, (New-Object System.Drawing.Size($Width, $Height)))
$g.Dispose()

$big = New-Object System.Drawing.Bitmap(($Width * $Scale), ($Height * $Scale))
$g2 = [System.Drawing.Graphics]::FromImage($big)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
$g2.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
$g2.DrawImage($bmp, 0, 0, $big.Width, $big.Height)
$g2.Dispose()
$big.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$big.Dispose()
$bmp.Dispose()
Write-Output ('wrote ' + $Out)
