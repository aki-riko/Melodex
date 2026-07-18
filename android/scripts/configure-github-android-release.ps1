[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern("^[^/]+/[^/]+$")]
    [string]$Repository,

    [string]$EnvironmentName = "android-release",
    [string]$TagPattern = "v*",
    [string]$Branch = "master",
    [string]$RequiredStatusCheck,
    [switch]$EnableBranchProtection
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Invoke-GhCommand([string[]]$Arguments) {
    $previousErrorAction = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $output = & gh @Arguments 2>&1
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorAction
    }
    if ($exitCode -ne 0) {
        throw "gh command failed ($exitCode): $($output -join [Environment]::NewLine)"
    }
    return ($output -join [Environment]::NewLine)
}

function Invoke-GhJsonApi(
    [ValidateSet("POST", "PUT", "PATCH")]
    [string]$Method,
    [string]$Endpoint,
    [object]$Body
) {
    $temporaryFile = [IO.Path]::GetTempFileName()
    try {
        $json = $Body | ConvertTo-Json -Depth 10 -Compress
        [IO.File]::WriteAllText($temporaryFile, $json, [Text.UTF8Encoding]::new($false))
        $raw = Invoke-GhCommand @("api", "--method", $Method, $Endpoint, "--input", $temporaryFile)
        if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
        return $raw | ConvertFrom-Json
    }
    finally {
        Remove-Item -LiteralPath $temporaryFile -Force -ErrorAction SilentlyContinue
    }
}

Invoke-GhCommand @("auth", "status") | Out-Null
$user = (Invoke-GhCommand @("api", "user")) | ConvertFrom-Json
if (-not $user.id) { throw "Unable to resolve the current GitHub user id." }

$environmentEndpoint = "repos/$Repository/environments/$EnvironmentName"
$environmentBody = [ordered]@{
    wait_timer = 0
    prevent_self_review = $false
    reviewers = @(
        [ordered]@{
            type = "User"
            id = [long]$user.id
        }
    )
    deployment_branch_policy = [ordered]@{
        protected_branches = $false
        custom_branch_policies = $true
    }
}
Invoke-GhJsonApi "PUT" $environmentEndpoint $environmentBody | Out-Null

$policiesEndpoint = "$environmentEndpoint/deployment-branch-policies"
$policies = (Invoke-GhCommand @("api", $policiesEndpoint)) | ConvertFrom-Json
$matchingPolicies = @($policies.branch_policies | Where-Object {
    $_.name -eq $TagPattern -and $_.type -eq "tag"
})
if ($matchingPolicies.Count -eq 0) {
    $conflictingPolicies = @($policies.branch_policies | Where-Object { $_.name -eq $TagPattern })
    if ($conflictingPolicies.Count -gt 0) {
        throw "A deployment policy named '$TagPattern' exists but is not a tag policy."
    }
    $policyBody = [ordered]@{ name = $TagPattern; type = "tag" }
    Invoke-GhJsonApi "POST" $policiesEndpoint $policyBody | Out-Null
}

Write-Host "Configured Environment '$EnvironmentName' with required reviewer '$($user.login)' and tag policy '$TagPattern'."

if ($EnableBranchProtection) {
    if ([string]::IsNullOrWhiteSpace($RequiredStatusCheck)) {
        throw "-RequiredStatusCheck is required with -EnableBranchProtection. Read it from the first successful GitHub check run; do not guess it."
    }
    $encodedBranch = [Uri]::EscapeDataString($Branch)
    $protectionBody = [ordered]@{
        required_status_checks = [ordered]@{
            strict = $true
            contexts = @($RequiredStatusCheck)
        }
        enforce_admins = $false
        required_pull_request_reviews = $null
        restrictions = $null
        required_linear_history = $true
        allow_force_pushes = $false
        allow_deletions = $false
        block_creations = $false
        required_conversation_resolution = $true
        lock_branch = $false
        allow_fork_syncing = $true
    }
    Invoke-GhJsonApi "PUT" "repos/$Repository/branches/$encodedBranch/protection" $protectionBody | Out-Null
    Write-Host "Protected branch '$Branch' with required check '$RequiredStatusCheck'."
}
