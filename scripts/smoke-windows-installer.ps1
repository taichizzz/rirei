param([Parameter(Mandatory = $true)][string]$PackageFile)

$ErrorActionPreference = 'Stop'
$tarball = (Get-Item -LiteralPath $PackageFile -ErrorAction Stop).FullName
$expectedVersion = (Get-Content (Join-Path $PSScriptRoot '../package.json') -Raw | ConvertFrom-Json).version
. (Join-Path $PSScriptRoot 'install-windows.ps1')

# Exercise native installation without persisting changes to the runner's user PATH.
$script:installerUserPath = 'C:\Existing Tools;%APPDATA%\npm'
function Get-RireiUserPath { return $script:installerUserPath }
function Set-RireiUserPath([string]$Value) { $script:installerUserPath = $Value }

$originalPath = $env:Path
$originalDataHome = $env:RIREI_DATA_HOME
$temporary = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Temp'
$root = Join-Path $temporary ('rirei-native-installer-' + [guid]::NewGuid())
$prefix = Join-Path $root 'CLI with spaces'
$state = Join-Path $root 'project/.relay/state.json'
$preferences = Join-Path $root 'data/token-usage-opt-in.json'
$env:RIREI_DATA_HOME = Join-Path $root 'data'

try {
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($state)) | Out-Null
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($preferences)) | Out-Null
    [IO.File]::WriteAllText($state, 'KEEP_PROJECT_STATE')
    [IO.File]::WriteAllText($preferences, '{"optIn":false}')

    Install-Rirei -Version $expectedVersion -InstallRoot $prefix -PackageFile $tarball -NonInteractive
    if (-not $script:installerUserPath.StartsWith($prefix + ';')) { throw 'Installer did not prepend its user PATH entry.' }
    if (-not (Test-Path -LiteralPath (Join-Path $prefix 'relay.cmd'))) { throw 'Installer did not create the CLI shim.' }

    Install-Rirei -Version $expectedVersion -InstallRoot $prefix -Uninstall -NonInteractive
    if ($script:installerUserPath -ne 'C:\Existing Tools;%APPDATA%\npm') { throw 'Uninstall changed unrelated PATH entries.' }
    if (Test-Path -LiteralPath (Join-Path $prefix 'relay.cmd')) { throw 'Uninstall left the CLI shim behind.' }
    if ([IO.File]::ReadAllText($state) -ne 'KEEP_PROJECT_STATE') { throw 'Installer changed project state.' }
    if ([IO.File]::ReadAllText($preferences) -ne '{"optIn":false}') { throw 'Installer changed analytics preferences.' }
    Write-Host 'Native Windows installer, diagnostics, and data-preserving uninstall passed.'
} finally {
    $env:Path = $originalPath
    $env:RIREI_DATA_HOME = $originalDataHome
    if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
