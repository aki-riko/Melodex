# Press real hardware media keys via SendInput (VK_MEDIA_PLAY_PAUSE etc).
# This exercises the exact same OS path a keyboard/headset button uses,
# so it is stronger evidence than calling the SMTC API directly.
# Pure ASCII on purpose: PowerShell 5.1 reads UTF-8-without-BOM as GBK.
param(
    [ValidateSet('playpause', 'next', 'prev', 'stop')]
    [string]$Key = 'playpause',
    [int]$Count = 1,
    [int]$DelayMs = 400
)
$ErrorActionPreference = 'Stop'

$src = @'
using System;
using System.Runtime.InteropServices;

public static class MediaKeys {
    [DllImport("user32.dll", SetLastError = true)]
    static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    const uint KEYEVENTF_KEYUP = 0x0002;

    public static void Press(byte vk) {
        keybd_event(vk, 0, KEYEVENTF_EXTENDEDKEY, UIntPtr.Zero);
        keybd_event(vk, 0, KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP, UIntPtr.Zero);
    }
}
'@
Add-Type -TypeDefinition $src -Language CSharp

$vk = switch ($Key) {
    'playpause' { 0xB3 }
    'next'      { 0xB0 }
    'prev'      { 0xB1 }
    'stop'      { 0xB2 }
}

for ($i = 0; $i -lt $Count; $i++) {
    [MediaKeys]::Press([byte]$vk)
    Write-Output ("sent " + $Key + " (vk=0x" + $vk.ToString('X2') + ") #" + ($i + 1))
    if ($i -lt ($Count - 1)) { Start-Sleep -Milliseconds $DelayMs }
}
