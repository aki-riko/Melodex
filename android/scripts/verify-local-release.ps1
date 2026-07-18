[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern("^v\d+\.\d+\.\d+(?:-rc\.\d+)?$")]
    [string]$Tag,

    [string]$JavaHome,
    [string]$BackupDirectory = (Join-Path ([Environment]::GetFolderPath("MyDocuments")) "Melodex\AndroidRelease"),
    [string]$PackageName = "life.nineli.melodex",
    [string]$BuildToolsVersion = "36.0.0",
    [int]$MinSdk = 26,
    [int]$TargetSdk = 36
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$JavaHome = if (-not [string]::IsNullOrWhiteSpace($JavaHome)) {
    $JavaHome
} elseif (-not [string]::IsNullOrWhiteSpace($env:MELODEX_JAVA_HOME)) {
    $env:MELODEX_JAVA_HOME
} else {
    $env:JAVA_HOME
}
$javaExecutable = if ($JavaHome) { Join-Path $JavaHome "bin\java.exe" } else { $null }
if (-not $javaExecutable -or -not (Test-Path -LiteralPath $javaExecutable -PathType Leaf)) {
    throw "JDK 21 was not found. Pass -JavaHome or set MELODEX_JAVA_HOME."
}
$previousErrorAction = $ErrorActionPreference
try {
    $ErrorActionPreference = "Continue"
    $javaVersionText = (& $javaExecutable -version 2>&1) -join [Environment]::NewLine
    $javaVersionExitCode = $LASTEXITCODE
}
finally {
    $ErrorActionPreference = $previousErrorAction
}
if ($javaVersionExitCode -ne 0 -or $javaVersionText -notmatch 'version "21(?:\.|\")') {
    throw "JDK 21 is required, but JavaHome points to a different version: $JavaHome"
}

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$keystorePath = Join-Path $BackupDirectory "melodex-release.jks"
$credentialPath = Join-Path $BackupDirectory "credentials.dpapi"
$fingerprintPath = Join-Path $BackupDirectory "certificate.txt"
foreach ($requiredPath in @($keystorePath, $credentialPath, $fingerprintPath)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Missing release signing backup file: $requiredPath"
    }
}

$resolvedRaw = & node (Join-Path $PSScriptRoot "resolve-release-version.mjs") $Tag
if ($LASTEXITCODE -ne 0) { throw "Release version validation failed for tag '$Tag'." }
$resolved = $resolvedRaw | ConvertFrom-Json
$versionName = [string]$resolved.version_name
$versionCode = [string]$resolved.version_code

$sdkRoot = if ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } else { $env:ANDROID_HOME }
if ([string]::IsNullOrWhiteSpace($sdkRoot)) { throw "ANDROID_SDK_ROOT or ANDROID_HOME must be configured." }
$buildToolsRoot = Join-Path $sdkRoot "build-tools"
$buildTools = Join-Path $buildToolsRoot $BuildToolsVersion
if (-not (Test-Path -LiteralPath $buildTools -PathType Container)) {
    throw "Android build-tools $BuildToolsVersion is not installed under $buildToolsRoot."
}
$apkSigner = Join-Path $buildTools "apksigner.bat"
$aapt = Join-Path $buildTools "aapt.exe"
foreach ($tool in @($apkSigner, $aapt)) {
    if (-not (Test-Path -LiteralPath $tool -PathType Leaf)) { throw "Missing Android SDK tool: $tool" }
}

$previousEnvironment = @{}
foreach ($name in @("MELODEX_JAVA_HOME", "ANDROID_KEYSTORE_FILE", "ANDROID_KEYSTORE_PASSWORD", "ANDROID_KEY_ALIAS", "ANDROID_KEY_PASSWORD")) {
    $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}

$credentialJson = $null
$credentials = $null
$temporaryApkDirectory = $null
try {
    $env:MELODEX_JAVA_HOME = $JavaHome
    $encrypted = [IO.File]::ReadAllText($credentialPath, [Text.Encoding]::UTF8)
    $secure = ConvertTo-SecureString $encrypted
    $credentialJson = [Net.NetworkCredential]::new("", $secure).Password
    $credentials = $credentialJson | ConvertFrom-Json

    $env:ANDROID_KEYSTORE_FILE = $keystorePath
    $env:ANDROID_KEYSTORE_PASSWORD = [string]$credentials.storePassword
    $env:ANDROID_KEY_ALIAS = [string]$credentials.keyAlias
    $env:ANDROID_KEY_PASSWORD = [string]$credentials.keyPassword

    $tasks = @(
        "clean",
        "testDebugUnitTest",
        "lintDebug",
        "assembleRelease",
        "-PmelodexVersionName=$versionName",
        "-PmelodexVersionCode=$versionCode",
        "--no-daemon",
        "--no-build-cache"
    )
    & (Join-Path $projectRoot "android\build.cmd") @tasks
    if ($LASTEXITCODE -ne 0) { throw "Signed Release build failed with exit code $LASTEXITCODE." }

    $apkPath = Join-Path $projectRoot "android\app\build\outputs\apk\release\app-release.apk"
    if (-not (Test-Path -LiteralPath $apkPath -PathType Leaf)) { throw "Release APK was not produced: $apkPath" }

    # Legacy Windows Android SDK tools cannot open non-ASCII paths reliably.
    $temporaryApkDirectory = Join-Path ([IO.Path]::GetTempPath()) ("melodex-apk-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $temporaryApkDirectory | Out-Null
    $verificationApkPath = Join-Path $temporaryApkDirectory "app-release.apk"
    Copy-Item -LiteralPath $apkPath -Destination $verificationApkPath

    $signatureOutput = & $apkSigner verify --verbose --print-certs $verificationApkPath 2>&1
    if ($LASTEXITCODE -ne 0) { throw "apksigner verification failed: $($signatureOutput -join [Environment]::NewLine)" }
    $signatureText = $signatureOutput -join [Environment]::NewLine
    $actualDigestMatch = [regex]::Match($signatureText, "certificate SHA-256 digest:\s*([0-9a-fA-F]+)")
    if (-not $actualDigestMatch.Success) { throw "apksigner did not report a certificate SHA-256 digest." }

    $expectedCertificate = [IO.File]::ReadAllText($fingerprintPath, [Text.Encoding]::UTF8)
    $expectedDigestMatch = [regex]::Match($expectedCertificate, "SHA256:\s*([0-9a-fA-F:]+)")
    if (-not $expectedDigestMatch.Success) { throw "The signing backup does not contain a SHA256 fingerprint." }
    $actualDigest = $actualDigestMatch.Groups[1].Value.ToLowerInvariant()
    $expectedDigest = $expectedDigestMatch.Groups[1].Value.Replace(":", "").ToLowerInvariant()
    if ($actualDigest -ne $expectedDigest) { throw "The APK signer certificate does not match the release signing backup." }

    $badging = (& $aapt dump badging $verificationApkPath 2>&1) -join [Environment]::NewLine
    if ($LASTEXITCODE -ne 0) { throw "aapt failed to read APK metadata: $badging" }
    $packagePattern = "package: name='$([regex]::Escape($PackageName))' versionCode='$([regex]::Escape($versionCode))' versionName='$([regex]::Escape($versionName))'"
    if ($badging -notmatch $packagePattern) { throw "APK package or version metadata does not match the requested release." }
    if ($badging -notmatch "sdkVersion:'$MinSdk'") { throw "APK minSdk is not $MinSdk." }
    if ($badging -notmatch "targetSdkVersion:'$TargetSdk'") { throw "APK targetSdk is not $TargetSdk." }

    Write-Host "Verified signed APK: $apkPath"
    Write-Host "Package=$PackageName VersionName=$versionName VersionCode=$versionCode MinSdk=$MinSdk TargetSdk=$TargetSdk"
    Write-Host "CertificateSHA256=$actualDigest"
}
finally {
    if ($temporaryApkDirectory -and (Test-Path -LiteralPath $temporaryApkDirectory)) {
        Remove-Item -LiteralPath $temporaryApkDirectory -Recurse -Force
    }
    foreach ($name in $previousEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], "Process")
    }
    $credentials = $null
    $credentialJson = $null
    $secure = $null
    $encrypted = $null
}
