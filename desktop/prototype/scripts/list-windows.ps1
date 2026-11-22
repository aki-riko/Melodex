# List windows of a process, showing visibility and title.
# Pure ASCII on purpose: PowerShell 5.1 reads UTF-8-without-BOM as GBK.
param([string]$ProcessName = 'melodex-desktop-lyrics')
$ErrorActionPreference = 'Stop'

$src = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class WinList {
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
    public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int c);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);

    public static List<string> List(uint pid) {
        var result = new List<string>();
        EnumWindows(delegate(IntPtr h, IntPtr l) {
            uint owner;
            GetWindowThreadProcessId(h, out owner);
            if (owner == pid) {
                int n = GetWindowTextLength(h);
                var sb = new StringBuilder(n + 2);
                GetWindowText(h, sb, sb.Capacity);
                result.Add("hwnd=" + h + " visible=" + IsWindowVisible(h) + " title=" + sb.ToString());
            }
            return true;
        }, IntPtr.Zero);
        return result;
    }
}
'@
Add-Type -TypeDefinition $src -Language CSharp

$proc = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $proc) { Write-Output 'PROCESS_NOT_RUNNING'; exit 4 }
Write-Output ('PID ' + $proc.Id)
foreach ($line in [WinList]::List([uint32]$proc.Id)) { Write-Output $line }
