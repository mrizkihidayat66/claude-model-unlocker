<#
.SYNOPSIS
    Report the installed Claude Desktop version and the patch state.

.DESCRIPTION
    Read-only. Never modifies the installed package, the portable copy or the
    backup store. Use it to answer:

      - which Claude Desktop version is installed
      - whether the current patch rules still apply to that build
      - whether the portable copy exists and is self-consistent

    Exit codes: 0 = applicable/patched, 2 = incompatible, 1 = error.

.PARAMETER AsarPath
    Inspect an arbitrary app.asar instead of the installed one.

.PARAMETER Json
    Emit a single JSON object on stdout instead of the human-readable report.

.EXAMPLE
    .\scripts\inspect.ps1

.EXAMPLE
    .\scripts\inspect.ps1 -Json | ConvertFrom-Json
#>
[CmdletBinding()]
param(
    [string]$AsarPath,
    [switch]$Json
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\src\ps\Common.ps1')

$exitCode = 0

if (-not $Json) { Write-Step 'Claude Desktop - model unlock inspector' }

try {
    $package = Get-ClaudePackage
} catch {
    if ($Json) {
        [pscustomobject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Depth 4
    } else {
        Write-Fail $_.Exception.Message
    }
    exit 1
}

$targetAsar = if ($AsarPath) { $AsarPath } else { $package.AsarPath }
if (-not (Test-Path $targetAsar)) {
    if ($Json) {
        [pscustomobject]@{ ok = $false; error = "app.asar not found at: $targetAsar" } | ConvertTo-Json -Depth 4
    } else {
        Write-Fail "app.asar not found at: $targetAsar"
    }
    exit 1
}

try {
    $analysis = Invoke-NodeCli -Command 'analyse' -Arguments @($targetAsar)
} catch {
    if ($Json) {
        [pscustomobject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Depth 4
    } else {
        Write-Fail $_.Exception.Message
    }
    exit 1
}

$portable = Get-PortableLayout
$portableExists = Test-Path $portable.ExePath
$portableState = 'absent'

if ($portableExists -and (Test-Path $portable.AsarPath)) {
    try {
        $verification = Invoke-NodeCli -Command 'verify' -Arguments @($portable.AsarPath, $portable.ExePath)
        $portableState = if ($verification.consistent) { 'consistent' } else { 'inconsistent' }
    } catch {
        $portableState = 'unreadable'
    }
} elseif ($portableExists) {
    $portableState = 'missing-asar'
}

if ($Json) {
    [pscustomobject]@{
        ok             = $true
        toolVersion    = $script:ToolVersion
        specVersion    = $analysis.specVersion
        package        = $package
        asarPath       = $targetAsar
        asarSha256     = Get-FileSha256 $targetAsar
        status         = $analysis.status
        counts         = $analysis.counts
        rules          = $analysis.rules
        portable       = [pscustomobject]@{
            exists     = $portableExists
            appDir     = $portable.AppDir
            state      = $portableState
        }
        backupStoreBytes = Get-BackupStoreSize
    } | ConvertTo-Json -Depth 8
    exit $(if ($analysis.status -eq 'incompatible') { 2 } else { 0 })
}

Write-Info "tool version     : $($script:ToolVersion) (patch spec $($analysis.specVersion))"
Write-Info "package version  : $($package.Version)"
Write-Info "install location : $($package.InstallLocation)"
Write-Info "asar inspected   : $targetAsar"
Write-Info "asar sha256      : $(Get-FileSha256 $targetAsar)"

Write-Host ''
Write-Step 'Patch rules'
foreach ($rule in $analysis.rules) {
    $colour = switch ($rule.state) {
        'pending' { 'Yellow' }
        'applied' { 'Green' }
        default   { 'Red' }
    }
    Write-Host ('    [{0}] {1}' -f $rule.state.PadRight(12), $rule.id) -ForegroundColor $colour
    Write-Info ('             {0} (found {1}/{2})' -f $rule.title, $rule.found, $rule.expected)
    foreach ($location in $rule.locations) {
        Write-Info "             -> $($location.path) x$($location.count)"
    }
}

Write-Host ''
switch ($analysis.status) {
    'patched' {
        Write-Ok 'This archive is ALREADY PATCHED.'
    }
    'applicable' {
        Write-Ok 'This archive is APPLICABLE - run .\scripts\patch.ps1 to apply the unlock.'
    }
    'partial' {
        Write-Warn 'This archive is PARTIALLY patched. Re-running patch.ps1 will complete it.'
    }
    'incompatible' {
        Write-Fail 'This archive is INCOMPATIBLE with the current patch rules.'
        Write-Info 'Claude Desktop changed the relevant code. The patch deliberately'
        Write-Info 'refuses to guess; see docs/MAINTENANCE.md before adjusting the rules.'
        $exitCode = 2
    }
}

Write-Host ''
Write-Step 'Portable deployment'
if ($portableExists) {
    Write-Info "directory : $($portable.AppDir)"
    switch ($portableState) {
        'consistent' {
            Write-Ok 'portable copy is self-consistent (asar matches the digest in claude.exe)'
        }
        'inconsistent' {
            Write-Warn 'portable copy is INCONSISTENT - run .\scripts\patch.ps1 to rebuild it'
        }
        'missing-asar' {
            Write-Warn 'portable copy exists but has no app.asar'
        }
        default {
            Write-Warn 'portable copy could not be verified'
        }
    }
} else {
    Write-Info 'not created yet - run .\scripts\patch.ps1 to build it'
}

Write-Info ("backup store : {0:N1} MB" -f ((Get-BackupStoreSize) / 1MB))

exit $exitCode
