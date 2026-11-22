# Measure window geometry (size + position) of a process.
# Pure ASCII on purpose: PowerShell 5.1 reads UTF-8-without-BOM as GBK.
param([string]$ProcessName = 'melodex-desktop-lyrics')
$ErrorActionPreference = 'Stop'

$src = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class WinGeom {
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
    public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int c);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    public static List<string> List(uint pid) {
        var result = new List<string>();
        EnumWindows(delegate(IntPtr h, IntPtr l) {
            uint owner;
            GetWindowThreadProcessId(h, out owner);
            if (owner == pid) {
                int n = GetWindowTextLength(h);
                var sb = new StringBuilder(n + 2);
                GetWindowText(h, sb, sb.Capacity);
                RECT r;
                GetWindowRect(h, out r);
                int w = r.Right - r.Left;
                int hh = r.Bottom - r.Top;
                result.Add("hwnd=" + h
                    + " visible=" + IsWindowVisible(h)
                    + " size=" + w + "x" + hh
                    + " pos=(" + r.Left + "," + r.Top + ")"
                    + " title=" + sb.ToString());
            }
            return true;
        }, IntPtr.Zero);
        return result;
    }
}
'@

if (-not ('WinGeom' -as [type])) { Add-Type -TypeDefinition $src }

$proc = Get-Process -Name $ProcessName -ErrorAction Stop
foreach ($line in [WinGeom]::List([uint32]$proc.Id)) { Write-Output $line }
