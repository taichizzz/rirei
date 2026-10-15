# Install the Windows CLI alpha

The alpha.5.1 GitHub release includes a compiled npm tarball and a PowerShell installer.
Use the GitHub download steps below while npm registry publication is pending. Registry
commands become available when `@taichizzz/rirei@0.1.0-alpha.5.1` has been published.
Alpha.5.0 is a source-only release and cannot be installed from npm.

## Requirements

- Windows 10 version 1809 or newer; Windows Terminal is recommended.
- 64-bit Node.js 22.12+ and Git. Node.js 22 and 24 are exercised by the CLI publication workflow.
- Windows x64 is covered by CI. Windows ARM64 has shipped native dependencies and resolver
  coverage; native ARM64 terminal acceptance still needs a Windows ARM64 machine.
- Provider CLIs are installed and signed in separately. Rirei never installs providers or
  reads their credentials.

## npm registry installation (after publication)

In PowerShell or Command Prompt:

```powershell
npm.cmd install --global @taichizzz/rirei@alpha
relay.cmd --version
relay.cmd doctor --installation
```

For a reproducible version, replace `@alpha` with `@0.1.0-alpha.5.1`.
`relay` also works where PowerShell permits npm-generated scripts. If an execution policy
blocks `relay.ps1`, use `relay.cmd`; changing the machine-wide execution policy is unnecessary.

The package contains the compiled CLI. Installation does not clone the repository, run a
TypeScript build, or install Electron. The pinned `node-pty` package ships Windows x64 and
ARM64 prebuilds, and ccusage selects its platform-specific optional dependency. Keep npm's
optional dependencies enabled and do not force `build-from-source`.

## Guided PowerShell installer

Download the installer and compiled tarball from the exact GitHub release, then run the
installer with the local package:

```powershell
$release = "https://github.com/taichizzz/rirei/releases/download/v0.1.0-alpha.5.1"
Invoke-WebRequest "$release/install-windows.ps1" -OutFile install-windows.ps1
Invoke-WebRequest "$release/taichizzz-rirei-0.1.0-alpha.5.1.tgz" -OutFile rirei.tgz
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install-windows.ps1 -Version 0.1.0-alpha.5.1 -PackageFile .\rirei.tgz
```

The process-local execution-policy flag applies only to this script invocation.
The release includes `SHA256SUMS.txt`; `Get-FileHash -Algorithm SHA256` can verify each
download. Installation still downloads public runtime dependencies from npm. It does not
require the Rirei package itself to be published to the registry.

After npm publication, omit `-PackageFile` to install the same exact version from npm.

The installer:

1. Checks Windows version, architecture, Node.js, npm, and Git.
2. Offers to install missing prerequisites with WinGet. You can authorize this explicitly
   with `-InstallPrerequisites`. `-NonInteractive` never prompts and fails if prerequisites
   are missing without that option. Prerequisite installers may request elevation.
3. Installs the exact alpha from the local tarball or npm under `%LOCALAPPDATA%\Rirei\cli`
   using a per-command npm prefix.
4. Adds that prefix to the current user's PATH, preserving other entries and giving it
   precedence over older user-level Rirei installs. Re-running does not duplicate entries.
5. Checks the installed version, command discovery, Git, PTY addon, and ccusage binary.
   `doctor --installation` does not scan agent logs or probe provider authentication.

Use `-InstallRoot "C:\a user-writable folder\Rirei"` to choose a different absolute prefix.
Use `-WhatIf` to see the target without installing anything.

## First task

Open a Git project and launch the TUI:

```powershell
Set-Location "C:\Projects\my-app"
relay.cmd tui
# A project argument is also supported:
relay.cmd tui "C:\Projects\my-app"
```

First launch asks you to initialize local `.relay` settings, enter a task, and inspect the
installed providers. Existing uncommitted changes require an explicit acknowledgement.
Initialization and task start use the same operations and safeguards as `relay init` and
`relay start`. An existing active task opens the dashboard directly.

If the folder is not a Git repository, setup explains how to open one; it does not create
a repository automatically. Invalid settings are shown as errors and never reset.

Provider installation links and sign-in discovery states are shown before entering the
dashboard. Install or sign in through the provider's official CLI, then use Refresh to
discover it. Select a launcher to start, Enter to attach to a session, and Ctrl+Q to detach.
The daemon keeps sessions alive when the dashboard closes. Token analytics stays disabled
until explicitly enabled in its usage view or through the usage CLI.

## Update and uninstall

For a normal npm installation:

```powershell
npm.cmd install --global @taichizzz/rirei@alpha
npm.cmd uninstall --global @taichizzz/rirei
```

For an installation made with the setup script, download the new release's script and
tarball and rerun with the new exact version and `-PackageFile`. For a registry installation,
omit `-PackageFile`. Uninstall with the same prefix:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install-windows.ps1 -Uninstall
```

The script removes the package and its own user PATH entry. Project `.relay` directories
and `%LOCALAPPDATA%\Rirei` usage data/preferences remain. Stop your Rirei sessions before
upgrading or uninstalling so native PTY files are not held open by the daemon.

## Troubleshooting

- **Command not found:** open a new terminal. For the script's prefix, test
  `& "$env:LOCALAPPDATA\Rirei\cli\relay.cmd" doctor --installation`.
- **Wrong Node.js:** install a 64-bit Node.js version meeting the minimum, then reopen the terminal.
- **PTY or ccusage missing:** reinstall with optional dependencies and package install scripts
  enabled. The diagnostics command reports native dependency status without scanning logs.
- **Provider missing:** follow the official setup link in the TUI and use Refresh after installation.
- **npm registry returns 404:** check whether the requested alpha has been published; a GitHub
  source release alone does not publish an npm package.
