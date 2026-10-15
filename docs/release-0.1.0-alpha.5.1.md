# Rirei 0.1.0-alpha.5.1

This alpha prepares the Windows terminal installation path and a guided first task.

## Installation

- The CLI package is prepared for public npm publication under the `alpha` dist-tag.
  It includes a compiled entry point and keeps Electron out of the CLI installation.
- A PowerShell installer checks Windows, Node.js, npm, and Git; missing prerequisites are
  installed through WinGet only when approved. Rirei installs into a user-level prefix.
- The compiled tarball, installer, and SHA-256 checksums are prepared together for the GitHub
  release. `-PackageFile` installs the downloaded tarball before npm registry publication.
- The installer pins an exact alpha version, preserves existing PATH entries, avoids duplicate
  entries on reruns, checks its installed version, and supports data-preserving uninstall.
- `relay doctor --installation --json` checks the native terminal and token collector without
  reading agent logs, probing provider authentication, or initializing a project.
- A manually dispatched publication workflow validates a matching tag on main, packs once,
  tests the same tarball across Windows/macOS/Linux on Node.js 22 and 24, and can publish
  through npm trusted publishing with provenance. Publication is disabled by default.

## First task

`relay tui [project]` now guides initialization and task creation when no active task exists.
The setup screen requires acknowledgement of an existing dirty tree, preserves existing
settings and active tasks, and shows official provider setup links. Providers retain their
own installation, authentication, and permissions. Token analytics remains opt-in.

## Verification

Local verification of the release candidate passed:

- Type checking, linting, formatting, build, and 639 tests; 3 platform-specific tests skipped.
- 32 benchmark tests and all 8 zero-provider dry-run fixtures.
- The 13-file npm package allowlist and production dependency audit (zero vulnerabilities).
- Global-prefix installation with spaces, first-task setup through a real PTY, daemon and
  terminal execution, reinstall, and uninstall.
- An upgrade from a tarball built at alpha.5.0 to alpha.5.1, preserving task state, settings,
  token preferences, and cache.
- 30 PowerShell installer assertions using mocked native commands and environment changes.
- macOS desktop build and packaged CLI/PTY smoke checks.

The Windows CI jobs also run mocked installer assertions and native installer/diagnostics/
uninstall smoke tests under PowerShell 7 and Windows PowerShell 5.1. Persistent user PATH
writes stay mocked in the native smoke test. Native Windows ARM64 terminal acceptance and
hands-on provider workflows still require their respective Windows environments.

## Publication status

The GitHub release tarball can be installed through the PowerShell script's `-PackageFile`
option. Registry-based installation becomes available only after npm publication. The scope
owner must configure npm authentication or the trusted publisher for `release.yml`.
See [Publication](publication.md) and [Windows installation](windows-install.md).

Public macOS installers continue to require Developer ID signing and notarization.
