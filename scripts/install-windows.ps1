[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$Version = '0.1.0-alpha.5.1',
    [string]$InstallRoot,
    [switch]$InstallPrerequisites,
    [switch]$NonInteractive,
    [switch]$Uninstall
)

function Get-RireiHost {
    $architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    return @{
        Windows = [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT
        Architecture = $architecture
        Build = [Environment]::OSVersion.Version.Build
    }
}

function Get-RireiCommand([string]$Name) {
    $command = Get-Command -Name $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    return $null
}

function Invoke-RireiNative {
    param([string]$File, [string[]]$Arguments, [switch]$Capture)
    if ($Capture) {
        $output = & $File @Arguments
    } else {
        & $File @Arguments | Out-Host
    }
    if ($LASTEXITCODE -ne 0) {
        throw "Installation command failed (exit $LASTEXITCODE). Review its output above and retry."
    }
    if ($Capture) { return (@($output) -join "`n") }
}

function Get-RireiUserPath { return [Environment]::GetEnvironmentVariable('Path', 'User') }
function Set-RireiUserPath([string]$Value) { [Environment]::SetEnvironmentVariable('Path', $Value, 'User') }

function Test-RireiPathEntry([string]$Entry, [string]$Expected) {
    $value = [Environment]::ExpandEnvironmentVariables($Entry.Trim().Trim('"')).TrimEnd('\', '/')
    return [string]::Equals($value, $Expected.TrimEnd('\', '/'), [StringComparison]::OrdinalIgnoreCase)
}

function Update-RireiUserPath([string]$Prefix, [switch]$Remove) {
    $original = Get-RireiUserPath
    $entries = @($original -split ';' | Where-Object { $_ -ne '' })
    $matching = @($entries | Where-Object { Test-RireiPathEntry $_ $Prefix })
    if ($Remove) {
        if ($matching.Count -gt 0) {
            Set-RireiUserPath (($entries | Where-Object { -not (Test-RireiPathEntry $_ $Prefix) }) -join ';')
        }
        $env:Path = (($env:Path -split ';' | Where-Object { -not (Test-RireiPathEntry $_ $Prefix) }) -join ';')
    } elseif ($entries.Count -eq 0 -or -not (Test-RireiPathEntry $entries[0] $Prefix)) {
        $others = @($entries | Where-Object { -not (Test-RireiPathEntry $_ $Prefix) })
        Set-RireiUserPath ((@($Prefix) + $others) -join ';')
    }
    if (-not $Remove) {
        $others = @($env:Path -split ';' | Where-Object { -not (Test-RireiPathEntry $_ $Prefix) })
        $env:Path = ((@($Prefix) + $others) -join ';')
    }
}

function Update-RireiProcessPath {
    $entries = @(
        [Environment]::GetEnvironmentVariable('Path', 'Machine') -split ';'
        (Get-RireiUserPath) -split ';'
        $env:Path -split ';'
    ) | Where-Object { $_ } | Select-Object -Unique
    $env:Path = ($entries -join ';')
}

function Test-RireiNode {
    $node = Get-RireiCommand 'node.exe'
    if (-not $node) { return $false }
    try {
        $details = (Invoke-RireiNative -File $node -Arguments @('-p', 'JSON.stringify({version:process.versions.node,arch:process.arch,platform:process.platform})') -Capture) | ConvertFrom-Json
        return ([version]$details.version -ge [version]'22.12.0' -and
            $details.platform -eq 'win32' -and $details.arch -in @('x64', 'arm64'))
    } catch {
        return $false
    }
}

function Install-Rirei {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [string]$Version = '0.1.0-alpha.5.1',
        [string]$InstallRoot,
        [switch]$InstallPrerequisites,
        [switch]$NonInteractive,
        [switch]$Uninstall
    )
    $ErrorActionPreference = 'Stop'
    $hostInfo = Get-RireiHost
    if (-not $hostInfo.Windows -or $hostInfo.Architecture -notin @('X64', 'Arm64') -or $hostInfo.Build -lt 17763) {
        throw 'Rirei requires 64-bit Windows 10 version 1809 or later (x64 or ARM64). Windows Terminal is recommended.'
    }
    if ($Version -notmatch '^\d+\.\d+\.\d+-alpha\.\d+(?:\.\d+)?$') {
        throw 'Pass an exact alpha version, for example -Version 0.1.0-alpha.5.1. Tags and version ranges are not accepted.'
    }
    if (-not $InstallRoot) {
        $localData = [Environment]::GetFolderPath('LocalApplicationData')
        $InstallRoot = Join-Path (Join-Path $localData 'Rirei') 'cli'
    }
    if (-not [IO.Path]::IsPathRooted($InstallRoot)) { throw 'InstallRoot must be an absolute user-writable directory.' }
    $prefix = [IO.Path]::GetFullPath($InstallRoot)
    $action = if ($Uninstall) { 'Uninstall the Rirei CLI; keep project and usage data' } else { "Install @taichizzz/rirei@$Version" }
    if (-not $PSCmdlet.ShouldProcess($prefix, $action)) { return }

    if ($Uninstall) {
        $npm = Get-RireiCommand 'npm.cmd'
        if (-not $npm) { throw 'npm is required to uninstall Rirei. Install Node.js 22.12 or later and retry.' }
        Invoke-RireiNative -File $npm -Arguments @('uninstall', '--global', '--prefix', $prefix, '@taichizzz/rirei', '--no-fund', '--no-audit')
        Update-RireiUserPath -Prefix $prefix -Remove
        Write-Host 'Rirei CLI removed. Your project .relay directories and token usage preferences were preserved.'
        return
    }

    $needsNode = -not (Test-RireiNode) -or -not (Get-RireiCommand 'npm.cmd')
    $needsGit = -not (Get-RireiCommand 'git.exe')
    if ($needsNode -or $needsGit) {
        $missing = @()
        if ($needsNode) { $missing += 'Node.js 22.12+ (64-bit, including npm)' }
        if ($needsGit) { $missing += 'Git' }
        $approved = $InstallPrerequisites.IsPresent
        if (-not $approved -and -not $NonInteractive) {
            $answer = Read-Host "Missing $($missing -join ', '). Install through WinGet? [y/N]"
            $approved = $answer -match '^(y|yes)$'
        }
        if (-not $approved) { throw "Install $($missing -join ', ') and retry, or use -InstallPrerequisites." }
        $winget = Get-RireiCommand 'winget.exe'
        if (-not $winget) { throw 'WinGet is unavailable. Install Node.js from https://nodejs.org and Git from https://git-scm.com, then retry.' }
        $ids = @()
        if ($needsNode) { $ids += 'OpenJS.NodeJS.LTS' }
        if ($needsGit) { $ids += 'Git.Git' }
        foreach ($id in $ids) {
            Invoke-RireiNative -File $winget -Arguments @('install', '--id', $id, '--exact', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity')
        }
        Update-RireiProcessPath
        if (-not (Test-RireiNode) -or -not (Get-RireiCommand 'npm.cmd') -or -not (Get-RireiCommand 'git.exe')) {
            throw 'Prerequisites were installed but are not visible yet. Open a new Windows Terminal window and rerun this script.'
        }
    }

    $npm = Get-RireiCommand 'npm.cmd'
    Invoke-RireiNative -File $npm -Arguments @('install', '--global', '--prefix', $prefix, "@taichizzz/rirei@$Version", '--no-fund', '--no-audit')
    $relay = Join-Path $prefix 'relay.cmd'
    if (-not (Test-Path -LiteralPath $relay -PathType Leaf)) { throw 'npm did not create relay.cmd in the selected install directory.' }
    $actual = (Invoke-RireiNative -File $relay -Arguments @('--version') -Capture).Trim()
    if ($actual -ne $Version) { throw 'The installed CLI version does not match the requested alpha. Installation has not been added to PATH.' }
    Update-RireiUserPath -Prefix $prefix
    $discovered = Get-RireiCommand 'relay.cmd'
    if (-not $discovered -or -not (Test-RireiPathEntry $discovered $relay)) {
        throw 'Another relay command is taking precedence. Open a new terminal or run relay.cmd from the selected install directory.'
    }
    $report = (Invoke-RireiNative -File $relay -Arguments @('doctor', '--installation', '--json') -Capture) | ConvertFrom-Json
    if (-not $report.ok) { throw 'Installation diagnostics failed. Run relay doctor --installation for details.' }
    Write-Host "Rirei $actual installed for the current user."
    Write-Host 'Open your Git project in Windows Terminal and run: relay tui'
    Write-Host 'If PowerShell blocks npm-generated scripts, use relay.cmd tui. No execution-policy change is required.'
    Write-Host 'Provider CLIs are installed and signed in separately. Token analytics stays opt-in.'
}

if ($MyInvocation.InvocationName -ne '.') {
    try { Install-Rirei @PSBoundParameters } catch { Write-Error $_; exit 1 }
}
