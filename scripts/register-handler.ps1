<#
.SYNOPSIS
    Register the patched portable Claude Desktop as a selectable claude:// handler.

.DESCRIPTION
    The Store-installed Claude package declares the claude:// protocol in its
    MSIX manifest, so Windows normally routes the sign-in callback to the Store
    app even when HKCU\Software\Classes\claude points at the portable copy. The
    portable profile then never receives the sign-in callback and the official
    app logs `desktop_login_callback_evicted`.

    This script adds a normal per-user Default Programs registration for the
    portable copy. After running it, choose "Claude (Portable)" for CLAUDE links
    in Windows Settings. The Store package is not modified, and the registration
    is reversible with -Unregister.

    Registry keys written (all under HKCU):
      Software\RegisteredApplications\ClaudeModelUnlocker
      Software\ClaudeModelUnlocker\Capabilities
      Software\Classes\claude            (ProgId used by the app itself)
      Software\Classes\Applications\claude.exe

.PARAMETER Unregister
    Remove the Default Programs registration added by this script.

.PARAMETER Status
    Show the current handler registration without changing anything.

.PARAMETER OpenSettings
    After registering, open the Windows Default Apps page for the portable app.

.EXAMPLE
    .\scripts\register-handler.ps1 -OpenSettings

.EXAMPLE
    .\scripts\register-handler.ps1 -Status

.EXAMPLE
    .\scripts\register-handler.ps1 -Unregister
#>
[CmdletBinding()]
param(
    [switch]$Unregister,
    [switch]$Status,
    [switch]$OpenSettings
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\src\ps\Common.ps1')

if ($Unregister -and $Status) {
    throw 'Use either -Unregister or -Status, not both.'
}

$portable = Get-PortableLayout
$exe = $portable.ExePath

$registeredName = 'ClaudeModelUnlocker'
$appDisplayName = 'Claude (Portable)'
$capabilitiesPath = 'Software\ClaudeModelUnlocker\Capabilities'
$registeredKey = 'HKCU:\Software\RegisteredApplications'
$capabilitiesKey = 'HKCU:\Software\ClaudeModelUnlocker\Capabilities'
$urlAssocKey = Join-Path $capabilitiesKey 'URLAssociations'
$progId = 'claude'
$progIdKey = 'HKCU:\Software\Classes\claude'
$applicationsKey = 'HKCU:\Software\Classes\Applications\claude.exe'
$userChoiceKey = 'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\claude\UserChoice'
$commandValue = '"' + $exe + '" "%1"'

function Get-RegistryValue {
    param([string]$Path, [string]$Name)

    if (-not (Test-Path $Path)) { return $null }
    $key = Get-Item -Path $Path -ErrorAction SilentlyContinue
    if (-not $key) { return $null }
    return $key.GetValue($Name)
}

function Get-KeyDefault {
    param([string]$Path)
    return Get-RegistryValue -Path $Path -Name ''
}

function Backup-RegistryKey {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$BackupDir,
        [Parameter(Mandatory)][string]$Name
    )

    if (-not (Test-Path $Path)) { return }
    $file = Join-Path $BackupDir ($Name + '.reg')
    $native = $Path -replace '^HKCU:', 'HKCU'
    & reg.exe export $native $file /y | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Failed to back up $Path to $file." }
}

function New-RegistryBackupDir {
    param([string]$Tag)

    $dir = Join-Path (Get-BackupRoot) ('registry-{0}-{1}' -f $Tag, (Get-Date -Format 'yyyyMMdd-HHmmss'))
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    return $dir
}

function Show-Status {
    $registered = if (Test-Path $registeredKey) {
        Get-RegistryValue -Path $registeredKey -Name $registeredName
    } else { $null }

    $urlAssoc = if (Test-Path $urlAssocKey) {
        Get-RegistryValue -Path $urlAssocKey -Name $progId
    } else { $null }

    $progIdCommand = Get-KeyDefault (Join-Path $progIdKey 'shell\open\command')
    $appCommand = Get-KeyDefault (Join-Path $applicationsKey 'shell\open\command')
    $userChoiceProgId = if (Test-Path $userChoiceKey) {
        Get-RegistryValue -Path $userChoiceKey -Name 'ProgId'
    } else { $null }

    Write-Host 'Claude portable handler status' -ForegroundColor Cyan
    Write-Host "  exe                         : $exe"
    Write-Host "  RegisteredApplications      : $registered"
    Write-Host "  URLAssociations\claude      : $urlAssoc"
    Write-Host "  ProgId claude command       : $progIdCommand"
    Write-Host "  Applications\claude.exe cmd : $appCommand"
    Write-Host "  Windows UserChoice ProgId   : $userChoiceProgId"

    $isRegistered = $registered -eq $capabilitiesPath -and $urlAssoc -eq $progId
    Write-Host "  registered by this script   : $isRegistered"
    if ($isRegistered -and $userChoiceProgId -ne $progId) {
        Write-Host '  action                      : choose Claude (Portable) for CLAUDE in Windows Settings'
    }
}

function Unregister-Handler {
    $dir = New-RegistryBackupDir -Tag 'unregister'
    Backup-RegistryKey -Path $registeredKey -BackupDir $dir -Name 'registered-applications'
    Backup-RegistryKey -Path $applicationsKey -BackupDir $dir -Name 'applications-claude-exe'

    if (Test-Path $registeredKey) {
        $current = Get-RegistryValue -Path $registeredKey -Name $registeredName
        if ($current -eq $capabilitiesPath) {
            Remove-ItemProperty -Path $registeredKey -Name $registeredName -Force
            Write-Host "Removed RegisteredApplications value $registeredName."
        } elseif ($null -ne $current) {
            Write-Warn "RegisteredApplications value $registeredName points elsewhere ($current); leaving it."
        }
    }

    if (Test-Path $capabilitiesKey) {
        Remove-Item -Path $capabilitiesKey -Recurse -Force
        $parent = Split-Path -Parent $capabilitiesKey
        if (Test-Path $parent) {
            $remaining = Get-ChildItem -Path $parent -Force -ErrorAction SilentlyContinue
            if (-not $remaining) { Remove-Item -Path $parent -Recurse -Force }
        }
        Write-Host 'Removed the portable Default Programs capabilities entry.'
    }

    $appCommand = Get-KeyDefault (Join-Path $applicationsKey 'shell\open\command')
    if ($appCommand -and $appCommand -like "*$exe*") {
        Remove-Item -Path $applicationsKey -Recurse -Force
        Write-Host 'Removed the portable Applications\claude.exe entry.'
    }

    Write-Host ''
    Write-Host 'The HKCU\Software\Classes\claude ProgId was left in place because the app uses it.'
    Write-Host 'If you had selected Claude (Portable) for CLAUDE links, change that default in Windows Settings.'
    Write-Host "Registry backups: $dir"
}

function Register-Handler {
    if (-not (Test-Path $exe)) {
        throw "Patched portable build not found at $exe. Run .\scripts\patch.ps1 first."
    }

    $dir = New-RegistryBackupDir -Tag 'register'
    Backup-RegistryKey -Path $registeredKey -BackupDir $dir -Name 'registered-applications'
    Backup-RegistryKey -Path $progIdKey -BackupDir $dir -Name 'classes-claude'
    Backup-RegistryKey -Path $applicationsKey -BackupDir $dir -Name 'applications-claude-exe'

    New-Item -Path $progIdKey -Force | Out-Null
    Set-Item -Path $progIdKey -Value 'URL:claude'
    New-ItemProperty -Path $progIdKey -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
    $iconKey = Join-Path $progIdKey 'DefaultIcon'
    New-Item -Path $iconKey -Force | Out-Null
    Set-Item -Path $iconKey -Value ($exe + ',0')
    $progIdCommandKey = Join-Path $progIdKey 'shell\open\command'
    New-Item -Path $progIdCommandKey -Force | Out-Null
    Set-Item -Path $progIdCommandKey -Value $commandValue

    New-Item -Path $capabilitiesKey -Force | Out-Null
    New-ItemProperty -Path $capabilitiesKey -Name 'ApplicationName' -Value $appDisplayName -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $capabilitiesKey -Name 'ApplicationDescription' -Value 'Patched Claude Desktop portable copy (model-ID unlock)' -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $capabilitiesKey -Name 'ApplicationIcon' -Value ($exe + ',0') -PropertyType String -Force | Out-Null
    New-Item -Path $urlAssocKey -Force | Out-Null
    New-ItemProperty -Path $urlAssocKey -Name $progId -Value $progId -PropertyType String -Force | Out-Null

    if (-not (Test-Path $registeredKey)) {
        New-Item -Path $registeredKey -Force | Out-Null
    }
    New-ItemProperty -Path $registeredKey -Name $registeredName -Value $capabilitiesPath -PropertyType String -Force | Out-Null

    $existingAppCommand = Get-KeyDefault (Join-Path $applicationsKey 'shell\open\command')
    if ($existingAppCommand -and $existingAppCommand -notlike "*$exe*") {
        Write-Warn "Applications\claude.exe is registered to a different command; leaving it unchanged:`n  $existingAppCommand"
    } else {
        New-Item -Path $applicationsKey -Force | Out-Null
        New-ItemProperty -Path $applicationsKey -Name 'FriendlyAppName' -Value $appDisplayName -PropertyType String -Force | Out-Null
        New-ItemProperty -Path $applicationsKey -Name 'ApplicationCompany' -Value 'Anthropic, PBC (portable)' -PropertyType String -Force | Out-Null
        $appIconKey = Join-Path $applicationsKey 'DefaultIcon'
        New-Item -Path $appIconKey -Force | Out-Null
        Set-Item -Path $appIconKey -Value ($exe + ',0')
        $appCommandKey = Join-Path $applicationsKey 'shell\open\command'
        New-Item -Path $appCommandKey -Force | Out-Null
        Set-Item -Path $appCommandKey -Value $commandValue
    }

    Write-Ok "Registered $appDisplayName as a per-user claude:// handler."
    Write-Host ''
    Write-Host 'One-time Windows Settings step:' -ForegroundColor Cyan
    Write-Host '  Settings > Apps > Default apps > Claude (Portable) > set CLAUDE to Claude (Portable)'
    Write-Host '  (or: Default apps > Choose a default for a link type > claude)'
    Write-Host ''
    Write-Host "Registry backups: $dir"
    Write-Host 'Undo with: .\scripts\register-handler.ps1 -Unregister'
}

if ($Status) {
    Show-Status
    return
}

if ($Unregister) {
    Unregister-Handler
    return
}

Register-Handler

if ($OpenSettings) {
    $uri = 'ms-settings:defaultapps?registeredAppUser=' + $registeredName
    try {
        Start-Process $uri | Out-Null
    } catch {
        Start-Process 'ms-settings:defaultapps' | Out-Null
    }
}
