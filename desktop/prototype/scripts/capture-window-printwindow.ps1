# Capture a specific window by HWND using PrintWindow (works even if covered).
# Pure ASCII on purpose: PowerShell 5.1 reads UTF-8-without-BOM as GBK.
param(
    [Parameter(Mandatory = $true)][string]$Out,
    [string]$Title = 'Melodex 桌面歌词',
    [int]$Scale = 1
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$src = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class WinCap {
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
    public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int c);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    public static IntPtr Find(string title) {
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

$hwnd = [WinCap]::Find($Title)
if ($hwnd -eq [IntPtr]::Zero) { Write-Output ('window not found or hidden: ' + $Title); exit 4 }

$rect = New-Object WinCap+RECT
[void][WinCap]::GetWindowRect($hwnd, [ref]$rect)
$w = $rect.Right - $rect.Left
$h = $rect.Bottom - $rect.Top
Write-Output ('hwnd=' + $hwnd + ' rect=' + $rect.Left + ',' + $rect.Top + ' ' + $w + 'x' + $h)

$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
# PW_RENDERFULLCONTENT (2) 才能抓到 WebView2 的分层内容
[void][WinCap]::PrintWindow($hwnd, $hdc, 2)
$g.ReleaseHdc($hdc)
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output ('wrote ' + $Out)
