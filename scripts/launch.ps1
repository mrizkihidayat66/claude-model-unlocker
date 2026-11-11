<#
.SYNOPSIS
    Launch the patched portable Claude Desktop with an isolated profile.

.DESCRIPTION
    Signed Claude Desktop builds delete CLAUDE_USER_DATA_DIR at startup unless a
    signed CDP token is present. The portable copy is patched so the variable
    survives (rule user-data-dir-env-preserved), which makes the app use a
    private userData directory: separate login state, config, logs, Chromium
    cache/sessionData and single-instance lock.

    Different profiles run side by side, and alongside the Store-installed app
    (which keeps using %LOCALAPPDATA%\Claude-3p).

.PARAMETER Profile
    Profile name: letters, digits, dot, underscore and dash only.
    Default: "default".

.PARAMETER Wait
    Block until the app exits instead of returning immediately.

.EXAMPLE
    .\scripts\launch.ps1

.EXAMPLE
    .\scripts\launch.ps1 -Profile work -Wait
#>
[CmdletBinding()]
param(
    [string]$Profile = 'default',
    [switch]$Wait
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\src\ps\Common.ps1')

$portable = Get-PortableLayout
if (-not (Test-Path $portable.ExePath)) {
    throw "Patched portable build not found at $($portable.ExePath). Run .\scripts\patch.ps1 first."
}

$profileDir = Resolve-ProfileDirectory -Name $Profile
New-Item -ItemType Directory -Path $profileDir -Force | Out-Null

# A claude:// callback (the browser sign-in hand-off) starts claude.exe without
# our environment. Record the active profile so the patched sanitizer can
# recover it; see the user-data-dir-env-preserved rule.
[System.IO.File]::WriteAllText($portable.AuthProfile, $profileDir)

$hadPrevious = Test-Path Env:\CLAUDE_USER_DATA_DIR
$previous = $env:CLAUDE_USER_DATA_DIR
$env:CLAUDE_USER_DATA_DIR = $profileDir
try {
    Write-Host 'Launching patched Claude Desktop' -ForegroundColor Cyan
    Write-Host "  profile : $Profile" -ForegroundColor DarkGray
    Write-Host "  data    : $profileDir" -ForegroundColor DarkGray
    if ($Wait) {
        & $portable.ExePath
    } else {
        Start-Process -FilePath $portable.ExePath | Out-Null
    }
} finally {
    if ($hadPrevious) { $env:CLAUDE_USER_DATA_DIR = $previous }
    else { Remove-Item Env:\CLAUDE_USER_DATA_DIR -ErrorAction SilentlyContinue }
}
