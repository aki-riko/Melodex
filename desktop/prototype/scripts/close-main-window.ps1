# Close the main window by sending WM_CLOSE (equivalent to clicking the X button).
# Pure ASCII on purpose: PowerShell 5.1 reads UTF-8-without-BOM as GBK.
param(
    [string]$ProcessName = 'melodex-desktop-lyrics',
    [int]$SettleSeconds = 3
)
$ErrorActionPreference = 'Stop'

$src = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class WinProbe {
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder name, int count);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    public const uint WM_CLOSE = 0x0010;

    public static List<IntPtr> WindowsOf(uint pid) {
        var found = new List<IntPtr>();
        EnumWindows((h, l) => {
            uint owner;
            GetWindowThreadProcessId(h, out owner);
            if (owner == pid) { found.Add(h); }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    public static string Title(IntPtr h) {
        int len = GetWindowTextLength(h);
        var sb = new StringBuilder(len + 2);
        GetWindowText(h, sb, sb.Capacity);
        return sb.ToString();
    }

    public static string Class(IntPtr h) {
        var sb = new StringBuilder(256);
        GetClassName(h, sb, sb.Capacity);
        return sb.ToString();
    }
}
'@
Add-Type -TypeDefinition $src -Language CSharp

$proc = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $proc) { Write-Output 'PROCESS_NOT_RUNNING'; exit 4 }
Write-Output ('PID ' + $proc.Id)

$windows = [WinProbe]::WindowsOf([uint32]$proc.Id)
Write-Output ('windows=' + $windows.Count)
$target = $null
foreach ($h in $windows) {
    $visible = [WinProbe]::IsWindowVisible($h)
    $title = [WinProbe]::Title($h)
    $cls = [WinProbe]::Class($h)
    Write-Output ('  hwnd=' + $h + ' visible=' + $visible + ' class=' + $cls + ' title=' + $title)
    if ($visible -and $title -eq 'Melodex') { $target = $h }
}

if ($null -eq $target) { Write-Output 'NO_VISIBLE_MAIN_WINDOW'; exit 5 }

Write-Output ('SENDING WM_CLOSE to ' + $target)
[void][WinProbe]::PostMessage($target, [WinProbe]::WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero)

Start-Sleep -Seconds $SettleSeconds

$after = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $after) { Write-Output 'RESULT=PROCESS_EXITED (bad: should stay alive)'; exit 6 }
Write-Output ('RESULT=PROCESS_ALIVE pid=' + $after.Id)

foreach ($h in [WinProbe]::WindowsOf([uint32]$after.Id)) {
    Write-Output ('  after hwnd=' + $h + ' visible=' + [WinProbe]::IsWindowVisible($h) + ' title=' + [WinProbe]::Title($h))
}
