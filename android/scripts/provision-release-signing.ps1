param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern("^[^/]+/[^/]+$")]
    [string]$Repository,
    [string]$EnvironmentName = "android-release",
    [string]$KeyAlias = "melodex",
    [string]$BackupDirectory = (Join-Path ([Environment]::GetFolderPath("MyDocuments")) "Melodex\AndroidRelease"),
    [string]$DistinguishedName = "CN=Melodex, OU=Release, O=Melodex, C=CN"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function New-RandomSecret([int]$ByteCount = 32) {
    $bytes = [byte[]]::new($ByteCount)
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $generator.GetBytes($bytes)
    }
    finally {
        $generator.Dispose()
    }
    return [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
}

function Set-EnvironmentSecret([string]$Name, [string]$Value) {
    $Value | & gh secret set $Name --repo $Repository --env $EnvironmentName
    if ($LASTEXITCODE -ne 0) { throw "Failed to write GitHub Secret: $Name" }
}

& gh auth status | Out-Null
if ($LASTEXITCODE -ne 0) { throw "GitHub CLI is not authenticated." }

$javaHome = if ($env:MELODEX_JAVA_HOME) { $env:MELODEX_JAVA_HOME } else { $env:JAVA_HOME }
$keytool = if ($javaHome) { Join-Path $javaHome "bin\keytool.exe" } else { $null }
if (-not $keytool -or -not (Test-Path $keytool)) {
    $keytool = (Get-Command keytool.exe -ErrorAction Stop).Source
}

New-Item -ItemType Directory -Force -Path $BackupDirectory | Out-Null
$userGrant = "$($env:USERNAME):(OI)(CI)F"
$qualifiedUserGrant = "$($env:USERDOMAIN)\$userGrant"
& icacls $BackupDirectory /inheritance:r /grant:r $qualifiedUserGrant "SYSTEM:(OI)(CI)F" | Out-Null

$keystorePath = Join-Path $BackupDirectory "melodex-release.jks"
$credentialPath = Join-Path $BackupDirectory "credentials.dpapi"
$fingerprintPath = Join-Path $BackupDirectory "certificate.txt"

if ((Test-Path $keystorePath) -xor (Test-Path $credentialPath)) {
    throw "The signing backup is incomplete; refusing to overwrite it. Inspect: $BackupDirectory"
}

if (Test-Path $keystorePath) {
    $encrypted = [IO.File]::ReadAllText($credentialPath)
    $secure = ConvertTo-SecureString $encrypted
    $credentialJson = [Net.NetworkCredential]::new("", $secure).Password
    $credentials = $credentialJson | ConvertFrom-Json
    $storePassword = [string]$credentials.storePassword
    $keyPassword = [string]$credentials.keyPassword
    $KeyAlias = [string]$credentials.keyAlias
} else {
    $storePassword = New-RandomSecret
    $keyPassword = $storePassword
    & $keytool -genkeypair -v `
        -keystore $keystorePath `
        -storetype PKCS12 `
        -storepass $storePassword `
        -keypass $keyPassword `
        -alias $KeyAlias `
        -keyalg RSA `
        -keysize 4096 `
        -validity 10000 `
        -dname $DistinguishedName
    if ($LASTEXITCODE -ne 0) { throw "Failed to generate the Android Release Key." }

    $credentialJson = [ordered]@{
        keyAlias = $KeyAlias
        storePassword = $storePassword
        keyPassword = $keyPassword
    } | ConvertTo-Json -Compress
    $encrypted = ConvertFrom-SecureString (ConvertTo-SecureString $credentialJson -AsPlainText -Force)
    [IO.File]::WriteAllText($credentialPath, $encrypted, [Text.UTF8Encoding]::new($false))
}

$certificate = & $keytool '-J-Duser.language=en' -list -v -keystore $keystorePath -storepass $storePassword -alias $KeyAlias
if ($LASTEXITCODE -ne 0) { throw "Failed to read the signing certificate." }
$safeCertificate = $certificate | Select-String -Pattern "Alias name:|Creation date:|Valid from:|SHA256:"
[IO.File]::WriteAllLines(
    $fingerprintPath,
    [string[]]($safeCertificate | ForEach-Object Line),
    [Text.UTF8Encoding]::new($false)
)

& gh api "repos/$Repository/environments/$EnvironmentName" --silent
if ($LASTEXITCODE -ne 0) { throw "GitHub Release Environment does not exist: $EnvironmentName" }

$keystoreBase64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($keystorePath))
Set-EnvironmentSecret "ANDROID_KEYSTORE_BASE64" $keystoreBase64
Set-EnvironmentSecret "ANDROID_KEYSTORE_PASSWORD" $storePassword
Set-EnvironmentSecret "ANDROID_KEY_ALIAS" $KeyAlias
Set-EnvironmentSecret "ANDROID_KEY_PASSWORD" $keyPassword

$keystoreBase64 = $null
$storePassword = $null
$keyPassword = $null
$credentialJson = $null

Write-Host "Release signing is configured."
Write-Host "Local DPAPI backup: $BackupDirectory"
Write-Host "Certificate details: $fingerprintPath"
Write-Warning "Copy melodex-release.jks, credentials.dpapi, and certificate.txt to offline media. The DPAPI recovery file can only be decrypted by the current Windows user."
