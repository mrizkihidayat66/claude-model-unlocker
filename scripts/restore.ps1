<#
.SYNOPSIS
    Restore the portable copy to an unpatched state, or manage the backup store.

.DESCRIPTION
    The installed MSIX package is the pristine source of truth and is never
    modified, so the default action is simply to re-seed the portable app.asar
    from it and re-sync the integrity digest in the portable claude.exe. That
    always produces a build that matches the installed version exactly.

    Use -FromBackup only when you specifically want an earlier portable state
    back (for example the build from before the last patch run).

    Modes:
      (default)      re-seed app.asar from the installed package
      -FromBackup    restore from the content-addressed backup store
      -ListBackups   list backup entries and exit
      -PruneBackups  drop old entries and unreferenced payloads, then exit
      -RemovePortable  delete the portable copy entirely

.EXAMPLE
    .\scripts\restore.ps1

.EXAMPLE
    .\scripts\restore.ps1 -ListBackups

.EXAMPLE
    .\scripts\restore.ps1 -FromBackup latest

.EXAMPLE
    .\scripts\restore.ps1 -RemovePortable
#>
[CmdletBinding()]
param(
    [switch]$Resync,
    [string]$FromBackup,
    [switch]$ListBackups,
    [switch]$PruneBackups,
    [int]$KeepDays = 14,
    [int]$KeepLast = 5,
    [switch]$RemovePortable
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\src\ps\Common.ps1')

Write-Step 'Claude Desktop - portable restore'

# --- Backup store administration -------------------------------------------
if ($ListBackups) {
    $entries = @(Get-BackupEntry)
    if ($entries.Count -eq 0) {
        Write-Info 'no backups recorded'
    } else {
        foreach ($entry in $entries) {
            $total = (@($entry.files) | Measure-Object -Property bytes -Sum).Sum
            Write-Host ('  {0}  {1,-10} {2,8:N1} MB  {3} file(s)' -f
                $entry.id, $entry.tag, ($total / 1MB), @($entry.files).Count)
            foreach ($file in @($entry.files)) {
                Write-Host ("      {0,-12} {1}  {2}" -f $file.leaf, $file.sha256.Substring(0, 12), $file.source) -ForegroundColor DarkGray
            }
        }
    }
    Write-Info ('store size : {0:N1} MB' -f ((Get-BackupStoreSize) / 1MB))
    exit 0
}

if ($PruneBackups) {
    $result = Remove-StaleBackups -KeepDays $KeepDays -KeepLast $KeepLast
    Write-Ok "removed $($result.removedEntries) entry/entries, kept $($result.keptEntries)"
    Write-Info ('store size : {0:N1} MB' -f ((Get-BackupStoreSize) / 1MB))
    exit 0
}

# --- Remove the portable copy ----------------------------------------------
if ($RemovePortable) {
    Write-Step 'Removing the portable copy'
    $portable = Get-PortableLayout
    if (Test-Path $portable.AppDir) {
        Remove-Item $portable.AppDir -Recurse -Force
        Write-Ok "removed $($portable.AppDir)"
    } else {
        Write-Info 'nothing to remove'
    }
    Write-Info 'Profiles and backups were left in place.'
    Write-Info 'The installed Claude Desktop (MSIX) was never modified.'
    exit 0
}

# --- Resolve the restore source --------------------------------------------
$package = Get-ClaudePackage
Write-Info "installed version : $($package.Version)"

$portable = Initialize-PortableCopy -Package $package
$useBackup = $FromBackup -and -not $Resync

if ($useBackup) {
    $entry = if ($FromBackup -eq 'latest') {
        @(Get-BackupEntry)[0]
    } else {
        @(Get-BackupEntry | Where-Object { $_.id -eq $FromBackup })[0]
    }
    if (-not $entry) { throw "No backup entry matches '$FromBackup'. See -ListBackups." }
    Write-Info "restoring from : $($entry.id)"
} else {
    Write-Info 'restoring from : installed package (pristine)'
}

# --- Restore ---------------------------------------------------------------
Write-Host ''
if ($useBackup) {
    Write-Step "Restoring from backup $($entry.id)"
    # Restore into the portable locations only, never into the MSIX package.
    # The recorded source paths are ignored: an entry may have been created on
    # another machine or after the portable copy moved.
    $restoreTargets = @{}
    foreach ($file in @($entry.files)) {
        $target = switch ($file.leaf) {
            'app.asar' { $portable.AsarPath }
            'claude.exe' { $portable.ExePath }
            default { $null }
        }
        if ($target) { $restoreTargets[$file.leaf] = $target }
    }
    if ($restoreTargets.Count -eq 0) { throw "Backup $($entry.id) holds no restorable files." }

    $objectsDir = Join-Path (Get-BackupRoot) 'objects'
    foreach ($file in @($entry.files)) {
        if (-not $restoreTargets.ContainsKey($file.leaf)) { continue }
        $objectPath = Join-Path $objectsDir $file.sha256
        if (-not (Test-Path $objectPath)) { throw "Backup object is missing: $objectPath" }
        $actual = Get-FileSha256 $objectPath
        if ($actual -ne $file.sha256) {
            throw "Backup object is corrupt: $objectPath (expected $($file.sha256), got $actual)"
        }
        Copy-Item $objectPath $restoreTargets[$file.leaf] -Force
        Write-Info "restored -> $($restoreTargets[$file.leaf])"
    }
} else {
    Write-Step 'Re-seeding the portable app.asar from the installed package'
    Copy-Item $package.AsarPath $portable.AsarPath -Force
    Write-Ok 'app.asar restored from the installed package (pristine, unpatched)'
}

# --- Re-sync the integrity digest so the restored build launches -----------
Write-Host ''
Write-Step 'Re-syncing the asar integrity digest'
try {
    $integrity = Invoke-NodeCli -Command 'update-integrity' -Arguments @($portable.ExePath, $portable.AsarPath)
    foreach ($change in $integrity.changes) {
        if ($change.changed) {
            Write-Info "digest updated: $($change.old.Substring(0, 16))... -> $($change.value.Substring(0, 16))..."
        }
    }
} catch {
    Write-Warn "Could not update the integrity digest: $($_.Exception.Message)"
}

# --- Verify ----------------------------------------------------------------
Write-Host ''
Write-Step 'Verifying'
$verification = Invoke-NodeCli -Command 'verify' -Arguments @($portable.AsarPath, $portable.ExePath)
if (-not $verification.consistent) {
    Write-Fail 'portable build is INCONSISTENT (asar digest does not match claude.exe)'
    exit 3
}
Write-Ok "portable build is self-consistent (digest $($verification.actual.Substring(0, 24))...)"

$analysis = Invoke-NodeCli -Command 'analyse' -Arguments @($portable.AsarPath)
Write-Info "patch state: $($analysis.status)"
if ($analysis.status -eq 'patched') {
    Write-Warn 'The portable archive is still patched. Run without -FromBackup to re-seed it.'
} else {
    Write-Ok 'portable archive is back to its unpatched state'
}

Write-Host ''
Write-Ok 'Restore complete.'
Write-Info 'The installed MSIX package was never modified at any point.'
