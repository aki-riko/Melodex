# Send a Ctrl+Alt+<key> combination via keybd_event (works regardless of focus).
# Pure ASCII on purpose: PowerShell 5.1 reads UTF-8-without-BOM as GBK.
# NOTE: keybd_event is used instead of SendInput because the INPUT struct layout
#       is tricky to get right from PowerShell (x64 sizeof(INPUT) is 40 bytes and
#       a hand-rolled union silently produces a wrong cbSize -> SendInput returns 0).
param(
    [ValidateSet('SPACE', 'LEFT', 'RIGHT')]
    [string]$Key = 'SPACE'
)
$ErrorActionPreference = 'Stop'

$src = @'
using System;
using System.Runtime.InteropServices;

public static class ComboKeys {
    [DllImport("user32.dll", SetLastError = true)]
    static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    const uint KEYEVENTF_KEYUP = 0x0002;
    const byte VK_CONTROL = 0x11;
    const byte VK_MENU = 0x12;

    public static void Send(byte vk, bool extended) {
        uint ext = extended ? KEYEVENTF_EXTENDEDKEY : 0;
        keybd_event(VK_CONTROL, 0, ext, UIntPtr.Zero);
        keybd_event(VK_MENU, 0, ext, UIntPtr.Zero);
        keybd_event(vk, 0, ext, UIntPtr.Zero);
        keybd_event(vk, 0, ext | KEYEVENTF_KEYUP, UIntPtr.Zero);
        keybd_event(VK_MENU, 0, ext | KEYEVENTF_KEYUP, UIntPtr.Zero);
        keybd_event(VK_CONTROL, 0, ext | KEYEVENTF_KEYUP, UIntPtr.Zero);
    }
}
'@
Add-Type -TypeDefinition $src -Language CSharp

$vk = switch ($Key) {
    'SPACE' { 0x20; break }
    'LEFT'  { 0x25; break }
    'RIGHT' { 0x27; break }
}
$extended = ($Key -ne 'SPACE')
# Explicit CLR type names: constrained-language mode rejects the [byte] alias.
[ComboKeys]::Send([System.Byte]$vk, $extended)
Write-Output ("sent Ctrl+Alt+" + $Key)
