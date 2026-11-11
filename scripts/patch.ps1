<#
.SYNOPSIS
    Build or update the patched portable copy of Claude Desktop.

.DESCRIPTION
    The installed MSIX package is never modified. This script:

      1. resolves the installed package and refreshes the portable copy when the
         package version changed,
      2. backs up the current portable archive when it is patched,
      3. seeds the portable app.asar from the installed package, so the patch is
         always applied to pristine bytes,
      4. analyses the archive against the structural patch rules and refuses to
         continue if the upstream code no longer matches,
      5. rewrites the archive, updates the ASAR integrity digest in the portable
         claude.exe, and verifies that the two agree.

    Safe to re-run after every official Claude Desktop update. If the rules no
    longer match, nothing is modified and the script exits with code 2.

.PARAMETER RefreshCopy
    Rebuild the portable copy from the installed package from scratch.

.PARAMETER Launch
    Launch the patched build when patching finishes.

.PARAMETER Profile
    Profile to launch with -Launch. Default: "default".

.PARAMETER KeepBackup
    Keep every backup entry; skip the post-patch pruning pass.

.PARAMETER DryRun
    Analyse and report what would change, then stop without writing anything.

.EXAMPLE
    .\scripts\patch.ps1

.EXAMPLE
    .\scripts\patch.ps1 -Launch -Profile work

.EXAMPLE
    .\scripts\patch.ps1 -DryRun
#>
[CmdletBinding()]
param(
    [switch]$RefreshCopy,
    [switch]$Launch,
    [string]$Profile = 'default',
    [switch]$KeepBackup,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\src\ps\Common.ps1')

Write-Step 'Claude Desktop - model unlock patcher'

# --- 1. Installed package and portable copy --------------------------------
try {
    $package = Get-ClaudePackage
} catch {
    Write-Fail $_.Exception.Message
    exit 1
}
Write-Info "installed version : $($package.Version)"
Write-Info "install location  : $($package.InstallLocation)"

$portable = Get-PortableLayout
if (-not $DryRun) {
    try {
        $portable = Initialize-PortableCopy -Package $package -Refresh:$RefreshCopy
    } catch {
        Write-Fail "Could not prepare the portable copy: $($_.Exception.Message)"
        exit 1
    }
    Write-Info "portable app      : $($portable.AppDir)"
}

# A dry run analyses the installed archive directly, so it works before the
# portable copy has ever been created.
$analysisTarget = if ($DryRun) { $package.AsarPath } else { $portable.AsarPath }
if (-not $DryRun) {
    # --- 2. Back up the current portable archive BEFORE touching it --------
    # Only a PATCHED archive is worth storing: an unpatched one is byte-identical
    # to the installed package and can be re-seeded at any time. claude.exe is
    # never backed up either, because it is a byte copy of the installed
    # executable apart from the embedded digest and is likewise re-derivable.
    #
    # The backup must happen before the seed below. The previous implementation
    # captured the archive after overwriting it with the pristine one, so every
    # "prepatch" backup was just a second copy of the unpatched archive.
    Write-Step 'Backing up the current portable archive'
    if (-not (Test-Path $portable.AsarPath)) {
        Write-Info 'nothing to back up yet (first run)'
    } else {
        try {
            $currentState = Invoke-NodeCli -Command 'analyse' -Arguments @($portable.AsarPath)
            if ($currentState.status -eq 'patched') {
                $backupEntry = Save-Backup -Tag 'prepatch' -Paths @($portable.AsarPath)
                Write-Info "backup : $($backupEntry.id) ($($backupEntry.files[0].sha256.Substring(0, 12)))"
            } else {
                Write-Info "not backing up: portable archive is '$($currentState.status)', not patched"
            }
        } catch {
            Write-Warn "Backup failed, continuing without one: $($_.Exception.Message)"
        }
    }

    # --- 3. Seed from the installed package --------------------------------
    Write-Step 'Seeding the portable app.asar from the installed package'
    Copy-Item $package.AsarPath $portable.AsarPath -Force
    Write-Info "source sha256 : $(Get-FileSha256 $package.AsarPath)"
}

# --- 4. Analyse ------------------------------------------------------------
Write-Host ''
Write-Step 'Analysing the archive against the patch rules'
try {
    $analysis = Invoke-NodeCli -Command 'analyse' -Arguments @($analysisTarget)
} catch {
    Write-Fail $_.Exception.Message
    exit 1
}

Write-Info "patch spec       : $($analysis.specVersion)"
foreach ($rule in $analysis.rules) {
    Write-Info ('{0,-13} {1,-32} found={2} expected={3}' -f $rule.state, $rule.id, $rule.found, $rule.expected)
}

if ($analysis.status -eq 'incompatible') {
    Write-Host ''
    Write-Fail 'The archive does not match the expected patch shape. Stopping WITHOUT modifying anything.'
    Write-Info 'Claude Desktop most likely changed the code that enforces the model-ID'
    Write-Info 'restriction. The patch will not guess. Inspect the new build, then update'
    Write-Info 'src/js/patch-spec.js (see docs/MAINTENANCE.md).'
    exit 2
}

if ($DryRun) {
    Write-Host ''
    if ($analysis.status -eq 'applicable') {
        Write-Ok "Dry run: this build is applicable. $($analysis.counts.pending) rule(s) would be applied."
    } else {
        Write-Info "Dry run: this build is '$($analysis.status)'. Nothing would change."
    }
    exit 0
}

if ($analysis.status -eq 'patched') {
    Write-Host ''
    Write-Ok 'The portable archive is already patched. Nothing to do.'
    Write-Info 'Re-run with -RefreshCopy to rebuild it from the installed package.'
    if ($Launch) { & (Join-Path $PSScriptRoot 'launch.ps1') -Profile $Profile }
    exit 0
}

# --- 5. Patch --------------------------------------------------------------
Write-Host ''
Write-Step 'Patching app.asar'
$tempAsar = "$($portable.AsarPath).new"
try {
    $patch = Invoke-NodeCli -Command 'patch' -Arguments @($portable.AsarPath, $tempAsar)
} catch {
    Write-Fail "Patch failed: $($_.Exception.Message)"
    Remove-Item -Path $tempAsar -Force -ErrorAction SilentlyContinue
    exit 3
}

Write-Info 'modifications:'
foreach ($modification in $patch.modifications) {
    Write-Info ('  {0,-32} {1}  ({2} replacement(s), {3} -> {4} bytes)' -f
        $modification.rule, $modification.file, $modification.replacements,
        $modification.beforeBytes, $modification.afterBytes)
}
if (@($patch.droppedCache).Count -gt 0) {
    Write-Info 'dropped stale V8 compile-cache entries:'
    foreach ($cache in $patch.droppedCache) { Write-Info "  $cache" }
}

Move-Item $tempAsar $portable.AsarPath -Force
Write-Ok "patched archive written ($((Get-Item $portable.AsarPath).Length) bytes)"

# --- 6. Embedded integrity digest ------------------------------------------
Write-Host ''
Write-Step 'Updating the asar integrity digest in the portable claude.exe'
try {
    $integrity = Invoke-NodeCli -Command 'update-integrity' -Arguments @($portable.ExePath, $portable.AsarPath)
    foreach ($change in $integrity.changes) {
        if ($change.changed) {
            Write-Info "digest updated: $($change.old.Substring(0, 16))... -> $($change.value.Substring(0, 16))..."
        }
    }
} catch {
    Write-Fail "Could not update the integrity digest: $($_.Exception.Message)"
    Write-Info 'The patched archive would be rejected by Electron. Aborting.'
    exit 4
}

# --- 7. Verify -------------------------------------------------------------
Write-Host ''
Write-Step 'Verifying the result'
try {
    $verification = Invoke-NodeCli -Command 'verify' -Arguments @($portable.AsarPath, $portable.ExePath)
} catch {
    Write-Fail "Verification could not run: $($_.Exception.Message)"
    exit 5
}

if (-not $verification.consistent) {
    Write-Fail "Verification FAILED: archive digest $($verification.actual) != expected $($verification.expected)"
    exit 5
}
Write-Ok "archive digest matches claude.exe: $($verification.actual.Substring(0, 24))..."
Write-Info "archive sha256 : $($verification.archiveSha256)"
Write-Info "installed asar sha256 (must be unchanged): $(Get-FileSha256 $package.AsarPath)"

$after = Invoke-NodeCli -Command 'analyse' -Arguments @($portable.AsarPath)
if ($after.status -ne 'patched') {
    Write-Fail "Post-patch analysis reports '$($after.status)', expected 'patched'."
    exit 6
}
Write-Ok 'post-patch analysis confirms all rules applied'

# --- 8. Backup retention ---------------------------------------------------
if (-not $KeepBackup) {
    try {
        $pruned = Remove-StaleBackups -KeepDays 14 -KeepLast 5
        if ($pruned.removedEntries -gt 0) {
            Write-Info "pruned $($pruned.removedEntries) old backup(s)"
        }
    } catch {
        Write-Warn "Backup pruning failed: $($_.Exception.Message)"
    }
}

# --- Done ------------------------------------------------------------------
Write-Host ''
Write-Ok 'Patch complete.'
Write-Host ''
Write-Host '  Installed Claude Desktop (MSIX) : UNCHANGED - still updates normally'
Write-Host "  Patched portable build          : $($portable.AppDir)"
Write-Host ''
Write-Host '  Launch it with:' -ForegroundColor Cyan
Write-Host '    .\scripts\launch.ps1                 # default profile' -ForegroundColor White
Write-Host '    .\scripts\launch.ps1 -Profile work   # a second, isolated instance' -ForegroundColor White
Write-Host '  Or re-run: .\scripts\patch.ps1 -Launch' -ForegroundColor DarkGray
Write-Host ''
Write-Host '  Profiles live in %LOCALAPPDATA%\ClaudeModelUnlocker\profiles\.' -ForegroundColor DarkGray
Write-Host '  Different profiles run side by side with each other and with the' -ForegroundColor DarkGray
Write-Host '  Store-installed app.' -ForegroundColor DarkGray

if ($Launch) {
    Write-Host ''
    Write-Step 'Launching the patched build'
    & (Join-Path $PSScriptRoot 'launch.ps1') -Profile $Profile
}
