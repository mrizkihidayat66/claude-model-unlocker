<#
.SYNOPSIS
    Tests for the content-addressed backup store in src\ps\Common.ps1.

.DESCRIPTION
    Runs against a throwaway runtime root, so the real deployment and the real
    backup store are never touched. Uses only Pester-free assertions so it works
    with the Windows PowerShell that ships with Windows.

.PARAMETER KeepTemp
    Leave the temporary runtime root in place for inspection.
#>
[CmdletBinding()]
param(
    [switch]$KeepTemp
)

$ErrorActionPreference = 'Stop'
$env:CLAUDE_MODEL_UNLOCKER_HOME = Join-Path ([System.IO.Path]::GetTempPath()) ('unlocker-store-' + [guid]::NewGuid().ToString('N'))
. (Join-Path $PSScriptRoot '..\..\src\ps\Common.ps1')

$failures = 0
function Assert-That {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][bool]$Condition,
        [string]$Detail = ''
    )
    if ($Condition) {
        Write-Host "  PASS  $Name"
    } else {
        Write-Host "  FAIL  $Name  $Detail"
        $script:failures++
    }
}

try {
    $sourceDir = Join-Path $script:RuntimeRoot 'source'
    New-Item -ItemType Directory -Path $sourceDir -Force | Out-Null

    $first = Join-Path $sourceDir 'app.asar'
    $second = Join-Path $sourceDir 'claude.exe'
    [System.IO.File]::WriteAllText($first, 'archive payload')
    [System.IO.File]::WriteAllText($second, 'executable payload')

    Write-Host '== store =='
    $entryA = Save-Backup -Tag 'test' -Paths @($first, $second)
    Assert-That 'entry records both files' (@($entryA.files).Count -eq 2)
    Assert-That 'entry id carries the tag' ($entryA.id -like 'test-*')

    $objectsDir = Join-Path (Get-BackupRoot) 'objects'
    $objectCount = @(Get-ChildItem $objectsDir -File).Count
    Assert-That 'two payloads stored' ($objectCount -eq 2) "count=$objectCount"

    # A second entry with identical bytes must not add objects.
    $entryB = Save-Backup -Tag 'test' -Paths @($first)
    $objectCountAfter = @(Get-ChildItem $objectsDir -File).Count
    Assert-That 'identical payload is deduplicated' ($objectCountAfter -eq 2) "count=$objectCountAfter"

    Write-Host '== listing =='
    $entries = @(Get-BackupEntry)
    Assert-That 'both entries listed' ($entries.Count -eq 2) "count=$($entries.Count)"
    Assert-That 'newest entry first' ($entries[0].id -eq $entryB.id)
    Assert-That 'tag filter works' (@(Get-BackupEntry -Tag 'test').Count -eq 2)

    Write-Host '== restore =='
    [System.IO.File]::WriteAllText($first, 'corrupted')
    Restore-Backup -Entry $entryA | Out-Null
    Assert-That 'restore brings back the original bytes' (
        (Get-Content $first -Raw) -eq 'archive payload'
    )

    # Corrupting a stored object must abort the restore instead of writing it.
    $sha = (Get-FileHash $second -Algorithm SHA256).Hash.ToLowerInvariant()
    [System.IO.File]::WriteAllText((Join-Path $objectsDir $sha), 'tampered')
    $threw = $false
    try { Restore-Backup -Entry $entryA | Out-Null } catch { $threw = $true }
    Assert-That 'corrupt object aborts the restore' $threw

    Write-Host '== pruning =='
    # Re-point the index so one entry is old, then prune with KeepDays 0/KeepLast 1.
    $index = Get-BackupIndex
    $entriesToKeep = @($index.backups)
    $entriesToKeep[0].created = (Get-Date).AddDays(-60).ToString('o')
    $entriesToKeep[1].created = (Get-Date).ToString('o')
    Save-BackupIndex ([pscustomobject]@{ version = 1; backups = $entriesToKeep })

    $pruned = Remove-StaleBackups -KeepDays 14 -KeepLast 1
    Assert-That 'old entry pruned' ($pruned.removedEntries -eq 1) "removed=$($pruned.removedEntries)"
    Assert-That 'recent entry kept' (@(Get-BackupEntry).Count -eq 1)

    $referenced = @(Get-BackupEntry)[0].files | ForEach-Object { $_.sha256 }
    $remainingObjects = @(Get-ChildItem $objectsDir -File | ForEach-Object { $_.Name })
    Assert-That 'unreferenced objects deleted' (
        $remainingObjects.Count -eq @($referenced).Count
    ) "objects=$($remainingObjects.Count) referenced=$(@($referenced).Count)"

    Write-Host '== profiles =='
    $profileDir = Resolve-ProfileDirectory -Name 'work-1'
    Assert-That 'profile resolves under the profiles root' (
        $profileDir -eq (Join-Path (Get-ProfilesRoot) 'work-1')
    )
    $threw = $false
    try { Resolve-ProfileDirectory -Name '..\escape' } catch { $threw = $true }
    Assert-That 'path traversal in a profile name is rejected' $threw
} finally {
    if (-not $KeepTemp) {
        Remove-Item -Path $script:RuntimeRoot -Recurse -Force -ErrorAction SilentlyContinue
    } else {
        Write-Host "kept: $($script:RuntimeRoot)"
    }
    Remove-Item Env:\CLAUDE_MODEL_UNLOCKER_HOME -ErrorAction SilentlyContinue
}

Write-Host ''
if ($failures -eq 0) {
    Write-Host 'ALL POWERSHELL CHECKS PASSED' -ForegroundColor Green
    exit 0
}
Write-Host ("{0} CHECK(S) FAILED" -f $failures) -ForegroundColor Red
exit 1
