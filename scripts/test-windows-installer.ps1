$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'install-windows.ps1')

$root = Join-Path ([IO.Path]::GetTempPath()) ("rirei-installer-test-" + [guid]::NewGuid())
$prefix = Join-Path $root 'CLI with spaces'
$state = Join-Path $root 'project/.relay/state.json'
$preferences = Join-Path $root 'data/token-usage-opt-in.json'
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($state)) | Out-Null
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($preferences)) | Out-Null
[IO.File]::WriteAllText($state, 'KEEP_PROJECT_STATE')
[IO.File]::WriteAllText($preferences, '{"optIn":false}')
$originalPath = $env:Path
$script:checks = 0
$script:calls = [Collections.Generic.List[object]]::new()

function Reset-RireiMocks {
    $script:calls.Clear()
    $script:userPath = 'C:\Existing Tools;%APPDATA%\npm;'
    $script:pathWrites = 0
    $script:hasNode = $true
    $script:hasGit = $true
    $script:hasWinget = $true
    $script:windows = $true
    $script:nodeVersion = '22.12.0'
    $script:installedVersion = '0.1.0-alpha.5.1'
    $script:failInstall = $false
    $env:Path = 'C:\Windows;C:\Existing Tools'
}

function Assert-Rirei($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
    $script:checks++
}

function Assert-RireiThrows([scriptblock]$Operation, [string]$Message) {
    $caught = $false
    try { & $Operation } catch { $caught = $true }
    Assert-Rirei $caught $Message
}

function Get-RireiHost { return @{ Windows = $script:windows; Architecture = 'X64'; Build = 22631 } }
function Get-RireiUserPath { return $script:userPath }
function Set-RireiUserPath([string]$Value) { $script:userPath = $Value; $script:pathWrites++ }
function Get-RireiCommand([string]$Name) {
    if ($Name -eq 'relay.cmd') { return (Join-Path $prefix 'relay.cmd') }
    if ($Name -eq 'node.exe' -and -not $script:hasNode) { return $null }
    if ($Name -eq 'git.exe' -and -not $script:hasGit) { return $null }
    if ($Name -eq 'winget.exe' -and -not $script:hasWinget) { return $null }
    return "C:\Mock Tools\$Name"
}
function Invoke-RireiNative {
    param([string]$File, [string[]]$Arguments, [switch]$Capture)
    $script:calls.Add(@{ File = $File; Arguments = $Arguments })
    if ($File.EndsWith('node.exe')) {
        return "{`"version`":`"$script:nodeVersion`",`"arch`":`"x64`",`"platform`":`"win32`"}"
    }
    if ($File.EndsWith('winget.exe')) {
        if ($Arguments -contains 'OpenJS.NodeJS.LTS') { $script:hasNode = $true; $script:nodeVersion = '24.0.0' }
        if ($Arguments -contains 'Git.Git') { $script:hasGit = $true }
        return
    }
    if ($File.EndsWith('npm.cmd') -and $Arguments[0] -eq 'install') {
        if ($script:failInstall) { throw 'Synthetic npm failure' }
        $destination = $Arguments[[Array]::IndexOf($Arguments, '--prefix') + 1]
        [IO.Directory]::CreateDirectory($destination) | Out-Null
        [IO.File]::WriteAllText((Join-Path $destination 'relay.cmd'), 'fixture')
        return
    }
    if ($Arguments -contains '--version') { return $script:installedVersion }
    if ($Arguments -contains 'doctor') { return '{"ok":true}' }
}

try {
    Reset-RireiMocks
    Install-Rirei -InstallRoot $prefix -NonInteractive
    $install = @($script:calls | Where-Object { $_.Arguments[0] -eq 'install' })[0]
    Assert-Rirei ($install.Arguments -contains '@taichizzz/rirei@0.1.0-alpha.5.1') 'Must install the exact requested alpha'
    Assert-Rirei ($install.Arguments -contains $prefix) 'Paths with spaces must remain a single argument'
    Assert-Rirei ($script:userPath.EndsWith('C:\Existing Tools;%APPDATA%\npm')) 'Existing user PATH entries must be preserved'
    Assert-Rirei ($script:userPath.StartsWith($prefix + ';')) 'The user prefix must take precedence over older user installs'
    Assert-Rirei (@($script:calls | Where-Object { $_.Arguments -contains '--installation' }).Count -eq 1) 'Must check package installation'
    Assert-Rirei (@($script:calls | Where-Object { $_.Arguments -contains 'usage' }).Count -eq 0) 'Installation must not scan agent logs'
    Install-Rirei -InstallRoot $prefix -NonInteractive
    Assert-Rirei ($script:pathWrites -eq 1) 'Rerunning must not duplicate PATH entries'
    Assert-Rirei ([IO.File]::ReadAllText($state) -eq 'KEEP_PROJECT_STATE') 'Reinstall must preserve project state'
    Assert-Rirei ([IO.File]::ReadAllText($preferences) -eq '{"optIn":false}') 'Reinstall must preserve analytics consent'
    Install-Rirei -InstallRoot $prefix -NonInteractive -Uninstall
    Assert-Rirei (-not $script:userPath.Contains($prefix)) 'Uninstall must remove only its PATH entry'
    Assert-Rirei ([IO.File]::ReadAllText($state) -eq 'KEEP_PROJECT_STATE') 'Uninstall must preserve project state'
    Assert-Rirei ([IO.File]::ReadAllText($preferences) -eq '{"optIn":false}') 'Uninstall must preserve usage preferences'

    Reset-RireiMocks
    $script:hasNode = $false
    $script:hasGit = $false
    Assert-RireiThrows { Install-Rirei -InstallRoot $prefix -NonInteractive } 'Missing prerequisites must require permission'
    Assert-Rirei (@($script:calls | Where-Object { $_.File.EndsWith('winget.exe') }).Count -eq 0) 'Must not run WinGet without consent'
    Install-Rirei -InstallRoot $prefix -NonInteractive -InstallPrerequisites
    Assert-Rirei (@($script:calls | Where-Object { $_.File.EndsWith('winget.exe') }).Count -eq 2) 'Must install only the two missing prerequisites'

    Reset-RireiMocks
    $script:nodeVersion = '20.0.0'
    Assert-RireiThrows { Install-Rirei -InstallRoot $prefix -NonInteractive } 'Old Node.js must not be accepted'
    Reset-RireiMocks
    $script:hasNode = $false
    $script:hasWinget = $false
    Assert-RireiThrows { Install-Rirei -InstallRoot $prefix -NonInteractive -InstallPrerequisites } 'Missing WinGet must give manual instructions'
    Reset-RireiMocks
    Assert-RireiThrows { Install-Rirei -InstallRoot $prefix -Version 'latest' -NonInteractive } 'Unpinned versions must be rejected'
    Assert-RireiThrows { Install-Rirei -InstallRoot $prefix -Version '1.2.3;bad' -NonInteractive } 'Invalid version strings must be rejected'
    Reset-RireiMocks
    Install-Rirei -InstallRoot $prefix -NonInteractive -WhatIf
    Assert-Rirei ($script:calls.Count -eq 0 -and $script:pathWrites -eq 0) 'WhatIf must not mutate the machine'
    Reset-RireiMocks
    $script:failInstall = $true
    Assert-RireiThrows { Install-Rirei -InstallRoot $prefix -NonInteractive } 'npm failure must be surfaced'
    Assert-Rirei ($script:pathWrites -eq 0) 'Failed installs must not change PATH'
    Reset-RireiMocks
    $script:windows = $false
    Assert-RireiThrows { Install-Rirei -InstallRoot $prefix -NonInteractive } 'Non-Windows hosts must be rejected'
    Write-Host "Windows installer: $script:checks assertions passed (mocked commands; no system changes)."
} finally {
    $env:Path = $originalPath
    Remove-Item -LiteralPath $root -Recurse -Force
}
