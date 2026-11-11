<#
.SYNOPSIS
    Shared helpers for the Claude Desktop model-unlock tooling.

.DESCRIPTION
    Every script in this repository dot-sources this file. It provides:

      - console output helpers with a consistent prefix style
      - discovery of the installed Claude Desktop MSIX package
      - the portable deployment layout (paths only; never created here)
      - the Node bridge used to run src/js/cli.js
      - a content-addressed backup store outside the repository

    The installed MSIX package is treated as strictly read-only. Nothing in
    this module writes inside C:\Program Files\WindowsApps; all mutation
    happens in a user-space portable copy under %LOCALAPPDATA%.

.NOTES
    Runtime state layout:

      %LOCALAPPDATA%\ClaudeModelUnlocker\
        portable\app\            patched copy of the installed app
        profiles\<name>\         isolated userData directories
        backups\objects\<sha>    deduplicated backup payloads
        backups\index.json       backup manifest
        auth-profile.txt         last profile, for claude:// callback launches

    Set CLAUDE_MODEL_UNLOCKER_HOME to relocate the whole runtime root.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# This file lives at <repo>\src\ps\Common.ps1.
$script:ToolRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

# Runtime root. CLAUDE_MODEL_UNLOCKER_HOME exists so tests and side-by-side
# installations can point at a different directory without touching the real
# deployment.
$script:RuntimeRoot = if ($env:CLAUDE_MODEL_UNLOCKER_HOME) {
    $env:CLAUDE_MODEL_UNLOCKER_HOME
} else {
    Join-Path $env:LOCALAPPDATA 'ClaudeModelUnlocker'
}
$script:PortableRoot = Join-Path $script:RuntimeRoot 'portable'
$script:ProfilesRoot = Join-Path $script:RuntimeRoot 'profiles'
$script:BackupRoot = Join-Path $script:RuntimeRoot 'backups'
$script:EngineCli = Join-Path $script:ToolRoot 'src\js\cli.js'
$script:AuthProfileFile = Join-Path $script:RuntimeRoot 'auth-profile.txt'

# Single source of truth for the tool version is package.json.
$script:ToolVersion = try {
    (Get-Content -Path (Join-Path $script:ToolRoot 'package.json') -Raw | ConvertFrom-Json).version
} catch {
    '0.0.0'
}

# --- Paths -----------------------------------------------------------------

function Get-ToolRoot { $script:ToolRoot }
function Get-RuntimeRoot { $script:RuntimeRoot }
function Get-PortableRoot { $script:PortableRoot }
function Get-ProfilesRoot { $script:ProfilesRoot }
function Get-BackupRoot { $script:BackupRoot }
function Get-AuthProfileFile { $script:AuthProfileFile }

<#
.SYNOPSIS
    Return the paths of the portable deployment without creating anything.
#>
function Get-PortableLayout {
    $appDir = Join-Path $script:PortableRoot 'app'
    $resourcesDir = Join-Path $appDir 'resources'
    return [pscustomobject]@{
        AppDir       = $appDir
        ResourcesDir = $resourcesDir
        AsarPath     = Join-Path $resourcesDir 'app.asar'
        ExePath      = Join-Path $appDir 'claude.exe'
        UnpackedPath = Join-Path $resourcesDir 'app.asar.unpacked'
        AuthProfile  = $script:AuthProfileFile
    }
}

# --- Console output --------------------------------------------------------

function Write-Step {
    param([Parameter(Mandatory)][string]$Message)
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Info {
    param([Parameter(Mandatory)][string]$Message)
    Write-Host "    $Message" -ForegroundColor DarkGray
}

function Write-Ok {
    param([Parameter(Mandatory)][string]$Message)
    Write-Host "    [OK] $Message" -ForegroundColor Green
}

function Write-Warn {
    param([Parameter(Mandatory)][string]$Message)
    Write-Host "    [WARN] $Message" -ForegroundColor Yellow
}

function Write-Fail {
    param([Parameter(Mandatory)][string]$Message)
    Write-Host "    [ERROR] $Message" -ForegroundColor Red
}

# --- Package discovery -----------------------------------------------------

<#
.SYNOPSIS
    Resolve the newest installed Claude Desktop MSIX package.

.DESCRIPTION
    Throws when the package is not installed for the current user. The returned
    object is a plain snapshot; no package API is called again later.
#>
function Get-ClaudePackage {
    $pkg = Get-AppxPackage -Name 'Claude' -ErrorAction SilentlyContinue |
        Sort-Object Version -Descending | Select-Object -First 1

    if (-not $pkg) {
        throw 'Claude Desktop (MSIX package "Claude") is not installed for the current user.'
    }

    $appDir = Join-Path $pkg.InstallLocation 'app'
    return [pscustomobject]@{
        Name             = $pkg.Name
        Version          = $pkg.Version.ToString()
        InstallLocation  = $pkg.InstallLocation
        PackageFullName  = $pkg.PackageFullName
        PackageFamilyName = $pkg.PackageFamilyName
        AppDir           = $appDir
        AsarPath         = Join-Path $appDir 'resources\app.asar'
        ExePath          = Join-Path $appDir 'claude.exe'
        UnpackedPath     = Join-Path $appDir 'resources\app.asar.unpacked'
    }
}

# --- Portable deployment ---------------------------------------------------

<#
.SYNOPSIS
    Create or refresh the portable copy of the installed app.

.DESCRIPTION
    Copies the installed app directory into %LOCALAPPDATA%\...\portable\app.
    app.asar is excluded: callers always seed it from the installed package, so
    the patch is applied to pristine bytes.

    The copy is only rebuilt when it is missing, when -Refresh is given, or when
    it was seeded from a different package version. The version marker makes an
    official update refresh the copy automatically.

.PARAMETER Package
    Result of Get-ClaudePackage.

.PARAMETER Refresh
    Delete and recreate the copy unconditionally.
#>
function Initialize-PortableCopy {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $Package,
        [switch]$Refresh
    )

    $layout = Get-PortableLayout
    $markerPath = Join-Path $layout.AppDir '.source-version'
    $installedVersion = if (Test-Path $markerPath) {
        (Get-Content -Path $markerPath -Raw).Trim()
    } else { $null }

    $needsCopy = $Refresh -or
        -not (Test-Path $layout.ExePath) -or
        $installedVersion -ne $Package.Version

    if ($needsCopy) {
        Write-Step "Creating portable copy of Claude Desktop $($Package.Version)"
        if (Test-Path $layout.AppDir) { Remove-Item $layout.AppDir -Recurse -Force }
        New-Item -ItemType Directory -Path $layout.ResourcesDir -Force | Out-Null

        Write-Info 'Copying app directory (this takes a minute)...'
        robocopy $Package.AppDir $layout.AppDir /E /NFL /NDL /NJH /NJS /NP /XF app.asar | Out-Null
        $rc = $LASTEXITCODE
        if ($rc -ge 8) { throw "robocopy failed with exit code $rc" }

        Set-Content -Path $markerPath -Value $Package.Version -Encoding ASCII
    }

    if ((Test-Path $Package.UnpackedPath) -and -not (Test-Path $layout.UnpackedPath)) {
        Write-Info 'Copying app.asar.unpacked (native modules)...'
        Copy-Item $Package.UnpackedPath $layout.UnpackedPath -Recurse -Force
    }

    return $layout
}

# --- Node bridge -----------------------------------------------------------

<#
.SYNOPSIS
    Run a src/js/cli.js subcommand and return its parsed JSON report.

.DESCRIPTION
    stdout carries the JSON report; stderr is left for diagnostics and is only
    surfaced when the command fails. This matters because Node prints warnings
    on stderr, and mixing the streams would corrupt the JSON.

.PARAMETER Command
    cli.js subcommand, for example 'analyse'.

.PARAMETER Arguments
    Positional arguments passed after the subcommand.
#>
function Invoke-NodeCli {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Command,
        [string[]]$Arguments = @()
    )

    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { throw 'node.exe was not found on PATH. Install Node.js 22 or newer.' }
    if (-not (Test-Path $script:EngineCli)) { throw "Missing tool script: $($script:EngineCli)" }

    $stderrFile = [System.IO.Path]::GetTempFileName()
    try {
        $stdout = & $node.Source $script:EngineCli $Command @Arguments 2> $stderrFile
        $exitCode = $LASTEXITCODE
        $text = ($stdout | Out-String).Trim()
        $errors = (Get-Content -Path $stderrFile -Raw -ErrorAction SilentlyContinue)

        if ($exitCode -ne 0) {
            $detail = if ($errors) { $errors.Trim() } else { $text }
            throw "Node command '$Command' failed (exit $exitCode):`n$detail"
        }
        if (-not $text) { throw "Node command '$Command' produced no output." }
        return $text | ConvertFrom-Json
    } finally {
        Remove-Item -Path $stderrFile -Force -ErrorAction SilentlyContinue
    }
}

# --- Hashing ---------------------------------------------------------------

<#
.SYNOPSIS
    SHA-256 of a file, lowercase hex.
#>
function Get-FileSha256 {
    param([Parameter(Mandatory)][string]$Path)
    return (Get-FileHash -Path $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

# --- Backup store ----------------------------------------------------------

<#
.SYNOPSIS
    Read the backup index, or an empty index when none exists.
#>
function Get-BackupIndex {
    $indexPath = Join-Path $script:BackupRoot 'index.json'
    if (-not (Test-Path $indexPath)) {
        return [pscustomobject]@{ version = 1; backups = @() }
    }
    $raw = Get-Content -Path $indexPath -Raw
    if (-not $raw.Trim()) { return [pscustomobject]@{ version = 1; backups = @() } }
    return $raw | ConvertFrom-Json
}

<#
.SYNOPSIS
    Write the backup index.
#>
function Save-BackupIndex {
    param([Parameter(Mandatory)] $Index)
    New-Item -ItemType Directory -Path $script:BackupRoot -Force | Out-Null
    $indexPath = Join-Path $script:BackupRoot 'index.json'
    $Index | ConvertTo-Json -Depth 8 | Set-Content -Path $indexPath -Encoding UTF8
}

<#
.SYNOPSIS
    Store files in the content-addressed backup store and return the entry.

.DESCRIPTION
    Payloads are stored once per SHA-256 under backups\objects\. Several backups
    that contain the same bytes (the usual case: the same pristine claude.exe in
    every run) therefore cost one copy instead of one per backup.

.PARAMETER Tag
    Label shown by Get-BackupEntry, for example 'prepatch' or 'handler'.

.PARAMETER Paths
    Files to capture. Missing paths are skipped.

.NOTES
    Back up app.asar only. claude.exe is a byte copy of the installed executable
    apart from its embedded digest, so it is always re-derivable and never worth
    a 235 MB payload in the store.
#>
function Save-Backup {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Tag,
        [Parameter(Mandatory)][string[]]$Paths
    )

    $objectsDir = Join-Path $script:BackupRoot 'objects'
    New-Item -ItemType Directory -Path $objectsDir -Force | Out-Null

    $files = @()
    foreach ($path in $Paths) {
        if (-not (Test-Path $path)) { continue }

        $sha = Get-FileSha256 $path
        $objectPath = Join-Path $objectsDir $sha
        if (-not (Test-Path $objectPath)) {
            Copy-Item $path $objectPath -Force
        }

        $files += [pscustomobject]@{
            source = $path
            leaf   = Split-Path -Leaf $path
            sha256 = $sha
            bytes  = (Get-Item $path).Length
        }
    }

    $entry = [pscustomobject]@{
        id      = '{0}-{1}' -f $Tag, (Get-Date -Format 'yyyyMMdd-HHmmss')
        tag     = $Tag
        created = (Get-Date).ToString('o')
        files   = $files
    }

    $index = Get-BackupIndex
    # ConvertFrom-Json collapses a one-element array to a scalar and returns
    # $null for an empty one, so normalise before appending.
    $existing = @(@($index.backups) | Where-Object { $_ })
    Save-BackupIndex ([pscustomobject]@{ version = 1; backups = @($existing + $entry) })

    return $entry
}

<#
.SYNOPSIS
    Return backup entries, newest first, optionally filtered by tag.
#>
function Get-BackupEntry {
    param([string]$Tag)

    $index = Get-BackupIndex
    # Wrap the pipeline result: under Set-StrictMode an empty pipeline collapses
    # to $null, and callers rely on .Count being present.
    # Callers must wrap the result in @(): an empty result unrolls to nothing and,
    # under Set-StrictMode, a bare .Count on it would throw. Do not use `, $arr`
    # here: that nests the array and yields a single element instead of none.
    return @(@($index.backups) |
        Where-Object { $_ -and (-not $Tag -or $_.tag -eq $Tag) } |
        Sort-Object { $_.created } -Descending)
}

<#
.SYNOPSIS
    Restore one backup entry into its original locations.

.DESCRIPTION
    Every object is verified against its recorded SHA-256 before it is copied.
    A mismatch aborts the whole restore rather than writing a corrupt file.

.PARAMETER Entry
    A backup entry from Get-BackupEntry.

.PARAMETER FileNames
    Only restore files with these leaf names. Default: everything in the entry.
#>
function Restore-Backup {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $Entry,
        [string[]]$FileNames
    )

    $objectsDir = Join-Path $script:BackupRoot 'objects'
    $files = @($Entry.files)
    if ($FileNames) {
        $files = @($files | Where-Object { $FileNames -contains $_.leaf })
    }
    if ($files.Count -eq 0) { throw "Backup $($Entry.id) has no matching files." }

    foreach ($file in $files) {
        $objectPath = Join-Path $objectsDir $file.sha256
        if (-not (Test-Path $objectPath)) {
            throw "Backup object is missing: $objectPath"
        }
        $actual = Get-FileSha256 $objectPath
        if ($actual -ne $file.sha256) {
            throw "Backup object is corrupt: $objectPath (expected $($file.sha256), got $actual)"
        }
    }

    foreach ($file in $files) {
        Copy-Item (Join-Path $objectsDir $file.sha256) $file.source -Force
        Write-Info "restored -> $($file.source)"
    }

    return $files
}

<#
.SYNOPSIS
    Delete backup entries older than a number of days and prune unused objects.

.PARAMETER KeepDays
    Retain entries created within this many days. Default 14.

.PARAMETER KeepLast
    Always retain this many most recent entries regardless of age. Default 5.
#>
function Remove-StaleBackups {
    [CmdletBinding()]
    param(
        [int]$KeepDays = 14,
        [int]$KeepLast = 5
    )

    if (-not (Test-Path $script:BackupRoot)) {
        return [pscustomobject]@{ removedEntries = 0; keptEntries = 0 }
    }

    $index = Get-BackupIndex
    $entries = @(@($index.backups) | Where-Object { $_ } | Sort-Object { $_.created } -Descending)
    $cutoff = (Get-Date).AddDays(-$KeepDays)

    $keep = @()
    $drop = @()
    for ($i = 0; $i -lt $entries.Count; $i++) {
        $entry = $entries[$i]
        $isRecent = $i -lt $KeepLast
        $isYoung = [datetime]::Parse($entry.created) -gt $cutoff
        if ($isRecent -or $isYoung) { $keep += $entry } else { $drop += $entry }
    }

    if ($drop.Count -gt 0) {
        Save-BackupIndex ([pscustomobject]@{ version = 1; backups = $keep })
    }

    # Delete objects no retained entry references.
    $referenced = New-Object 'System.Collections.Generic.HashSet[string]'
    foreach ($entry in $keep) {
        foreach ($file in @($entry.files)) { [void]$referenced.Add($file.sha256) }
    }

    $objectsDir = Join-Path $script:BackupRoot 'objects'
    if (Test-Path $objectsDir) {
        foreach ($object in Get-ChildItem -Path $objectsDir -File) {
            if (-not $referenced.Contains($object.Name)) {
                Remove-Item -Path $object.FullName -Force
            }
        }
    }

    return [pscustomobject]@{ removedEntries = $drop.Count; keptEntries = $keep.Count }
}

<#
.SYNOPSIS
    Total size of the backup store, in bytes.
#>
function Get-BackupStoreSize {
    if (-not (Test-Path $script:BackupRoot)) { return 0 }
    return (Get-ChildItem -Path $script:BackupRoot -Recurse -File -ErrorAction SilentlyContinue |
        Measure-Object -Property Length -Sum).Sum
}

# --- Profiles --------------------------------------------------------------

<#
.SYNOPSIS
    Validate and resolve a profile name to its userData directory.

.DESCRIPTION
    Profile names are restricted to letters, digits, dot, underscore and dash so
    a name can never escape the profiles directory.
#>
function Resolve-ProfileDirectory {
    param([Parameter(Mandatory)][string]$Name)

    if ($Name -notmatch '^[A-Za-z0-9._-]+$') {
        throw "Invalid profile name '$Name'. Use letters, digits, dot, underscore or dash."
    }
    return Join-Path $script:ProfilesRoot $Name
}
