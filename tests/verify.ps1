<#
.SYNOPSIS
    Run the static verification suite against the installed Claude Desktop.

.DESCRIPTION
    Read-only. Resolves the installed package (and the portable copy, when it
    exists) and runs tests\integration\verify.js against it.

    Use this after changing a patch rule, and after every Claude Desktop update
    before trusting the patch.

.PARAMETER AsarPath
    Verify a specific app.asar instead of the installed one.

.PARAMETER SkipPortable
    Skip the checks that need a patched portable copy.

.EXAMPLE
    .\tests\verify.ps1

.EXAMPLE
    .\tests\verify.ps1 -AsarPath D:\extracted\app.asar
#>
[CmdletBinding()]
param(
    [string]$AsarPath,
    [switch]$SkipPortable
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\src\ps\Common.ps1')

try {
    $package = Get-ClaudePackage
} catch {
    Write-Fail $_.Exception.Message
    exit 1
}

$sourceAsar = if ($AsarPath) { $AsarPath } else { $package.AsarPath }
if (-not (Test-Path $sourceAsar)) {
    Write-Fail "app.asar not found at: $sourceAsar"
    exit 1
}

$portable = Get-PortableLayout
$arguments = @(
    (Join-Path (Get-ToolRoot) 'tests\integration\verify.js'),
    $sourceAsar,
    '--installed-asar', $package.AsarPath
)

if (-not $SkipPortable -and (Test-Path $portable.AsarPath) -and (Test-Path $portable.ExePath)) {
    $arguments += @('--portable-asar', $portable.AsarPath, '--portable-exe', $portable.ExePath)
}

Write-Info "Claude Desktop $($package.Version)"
& node @arguments
exit $LASTEXITCODE
