<#
.SYNOPSIS
    Runtime proof that the patched portable build supports isolated profiles.

.DESCRIPTION
    Launches two patched instances with different CLAUDE_USER_DATA_DIR values,
    then verifies that both main processes stay alive, that each profile gets
    its own data/logs/lockfile, and that the shared default profile
    (%LOCALAPPDATA%\Claude-3p) is not touched.

    With -IncludeOfficial it also starts the Store-installed app and checks that
    it coexists with a patched instance.

    SAFETY: only processes created by this script are ever stopped, by PID and
    by descendant PID. Processes under Claude-3p\claude-code are the agent
    harness and are never targeted, and no unfiltered `claude.exe` kill is used.

.PARAMETER IncludeOfficial
    Also start the Store-installed app and test coexistence.

.PARAMETER StartupSeconds
    Seconds to wait after each launch. Default 14.

.EXAMPLE
    .\tests\multi-instance.ps1

.EXAMPLE
    .\tests\multi-instance.ps1 -IncludeOfficial
#>
[CmdletBinding()]
param(
    [switch]$IncludeOfficial,
    [int]$StartupSeconds = 14
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\src\ps\Common.ps1')

$portable = Get-PortableLayout
$exe = $portable.ExePath
$profilesRoot = Get-ProfilesRoot
$sharedLog = Join-Path $env:LOCALAPPDATA 'Claude-3p\logs\main.log'
$harnessPath = '*\Claude-3p\claude-code\*'

if (-not (Test-Path $exe)) { throw "portable build not found: $exe" }

$failures = 0
function Check([string]$Name, [bool]$Ok, [string]$Detail = '') {
    if ($Ok) {
        Write-Host ('  PASS  {0}' -f $Name)
    } else {
        Write-Host ('  FAIL  {0}  {1}' -f $Name, $Detail)
        $script:failures++
    }
}

function Get-AllClaudeProcesses {
    Get-CimInstance Win32_Process -Filter "Name='claude.exe'" -ErrorAction SilentlyContinue
}

function Get-MainProcesses([string]$PathLike) {
    Get-AllClaudeProcesses | Where-Object {
        $_.ExecutablePath -like $PathLike -and $_.CommandLine -notmatch '--type='
    }
}

function Get-DescendantIds([int[]]$RootIds) {
    $all = @(Get-AllClaudeProcesses)
    $ids = New-Object 'System.Collections.Generic.HashSet[int]'
    foreach ($root in $RootIds) { [void]$ids.Add([int]$root) }
    do {
        $added = $false
        foreach ($process in $all) {
            if ($ids.Contains([int]$process.ParentProcessId) -and -not $ids.Contains([int]$process.ProcessId)) {
                [void]$ids.Add([int]$process.ProcessId)
                $added = $true
            }
        }
    } while ($added)
    return @($ids)
}

function Stop-TrackedProcesses([int[]]$RootIds) {
    foreach ($id in (Get-DescendantIds $RootIds)) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
        if ($process -and $process.ExecutablePath -like $harnessPath) { continue }
        Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
    }
}

function Stop-AndCheck([int[]]$RootIds, [string]$Label) {
    Stop-TrackedProcesses $RootIds
    Start-Sleep -Seconds 4
    $left = @(Get-MainProcesses (Join-Path (Get-PortableRoot) '*') |
        Where-Object { $RootIds -contains [int]$_.ProcessId })
    Check "$Label stopped cleanly" ($left.Count -eq 0) ("left=" + $left.Count)
}

$sharedMtimeBefore = if (Test-Path $sharedLog) { (Get-Item $sharedLog).LastWriteTime } else { $null }
$officialRoots = @()
$officialPackage = $null

Write-Host '== launching two patched instances with isolated profiles =='
$profiles = @{
    'test-a' = Resolve-ProfileDirectory -Name 'test-a'
    'test-b' = Resolve-ProfileDirectory -Name 'test-b'
}
foreach ($dir in $profiles.Values) {
    if (Test-Path $dir) { Remove-Item $dir -Recurse -Force }
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
}

$pids = @()
foreach ($name in @('test-a', 'test-b')) {
    $env:CLAUDE_USER_DATA_DIR = $profiles[$name]
    $process = Start-Process -FilePath $exe -PassThru
    $pids += [int]$process.Id
    Write-Host ('  launched {0}: PID {1}' -f $name, $process.Id)
}
Remove-Item Env:\CLAUDE_USER_DATA_DIR -ErrorAction SilentlyContinue
Start-Sleep -Seconds $StartupSeconds

$alive = @($pids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
Check 'both launched main processes are alive' ($alive.Count -eq 2) ("alive=" + $alive.Count)

$mainProcesses = @(Get-MainProcesses (Join-Path (Get-PortableRoot) '*'))
Check 'at least 2 portable main processes are running' ($mainProcesses.Count -ge 2) ("count=" + $mainProcesses.Count)

foreach ($name in @('test-a', 'test-b')) {
    $dir = $profiles[$name]
    $log = Join-Path $dir 'Logs\main.log'
    Check "$name has its own log" (Test-Path $log)
    Check "$name has its own lockfile" (Test-Path (Join-Path $dir 'lockfile'))
    Check "$name has its own cache/session data" (
        (Test-Path (Join-Path $dir 'Cache')) -or (Test-Path (Join-Path $dir 'Session Storage'))
    )
    if (Test-Path $log) {
        Check "$name did not warn about an ignored env var" (
            -not (Select-String -Path $log -Pattern 'signed builds ignore it' -Quiet)
        )
        Check "$name did not lose the single-instance lock" (
            -not (Select-String -Path $log -Pattern 'single-instance lock' -Quiet)
        )
    }
}

$sharedMtimeAfter = if (Test-Path $sharedLog) { (Get-Item $sharedLog).LastWriteTime } else { $null }
Check 'shared Claude-3p profile was not written by the test instances' ($sharedMtimeAfter -eq $sharedMtimeBefore)

if ($IncludeOfficial) {
    Write-Host '== launching the Store-installed app alongside =='
    $officialPackage = Get-ClaudePackage
    $manifest = Get-AppxPackageManifest -Package $officialPackage.PackageFullName
    $application = @($manifest.Package.Applications.Application)[0]
    $aumid = "$($officialPackage.PackageFamilyName)!$($application.Id)"
    $officialPath = Join-Path $officialPackage.InstallLocation '*'

    $before = @(Get-MainProcesses $officialPath | ForEach-Object { [int]$_.ProcessId })
    Start-Process "shell:AppsFolder\$aumid"
    Start-Sleep -Seconds $StartupSeconds
    $after = @(Get-MainProcesses $officialPath)
    $officialRoots = @($after | Where-Object { $before -notcontains [int]$_.ProcessId } |
        ForEach-Object { [int]$_.ProcessId })

    Check 'official app started' ($officialRoots.Count -ge 1) ("new=" + $officialRoots.Count)
    $officialAlive = @($officialRoots | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
    $portableAliveNow = @($pids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
    Check 'official and patched instances coexist' (
        $officialAlive.Count -ge 1 -and $portableAliveNow.Count -eq 2
    )
}

Write-Host '== cleanup (tracked PIDs only) =='
Stop-AndCheck $pids 'portable instances'
if ($officialRoots.Count -gt 0 -and $officialPackage) {
    Stop-TrackedProcesses $officialRoots
    Start-Sleep -Seconds 4
    $leftOfficial = @(Get-MainProcesses (Join-Path $officialPackage.InstallLocation '*') |
        Where-Object { $officialRoots -contains [int]$_.ProcessId })
    Check 'official instances stopped cleanly' ($leftOfficial.Count -eq 0) ("left=" + $leftOfficial.Count)
}

$harnessCount = @(Get-AllClaudeProcesses | Where-Object { $_.ExecutablePath -like $harnessPath }).Count
Write-Info "harness processes present after cleanup: $harnessCount (never targeted)"

Write-Host ''
if ($failures -eq 0) {
    Write-Host 'RESULT: MULTI-INSTANCE WORKS' -ForegroundColor Green
    exit 0
}
Write-Host ("RESULT: FAILED ({0} check(s))" -f $failures) -ForegroundColor Red
exit 1
