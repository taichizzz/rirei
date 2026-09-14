# Rirei 0.1.0-alpha.4.2 release preparation

Status: release candidate prepared and validated locally.

## Release summary

This alpha adds secure, task-scoped Relay Threads with authenticated run identities, bounded
storage, explicit redaction, durable receipts, session labels, and desktop and TUI inbox workflows.

Terminal sessions now support reliable selected/all-session shutdown and portable attachment with
read-only viewing, explicit takeover, daemon-enforced single-writer control, bounded replay, and
safe terminal restoration. Daemon discovery, heartbeat, final-state synchronization, output
retention, bridge-worker framing, and Electron reconnect ownership are hardened.

The Rirei desktop adopts the 3a control-room layout while preserving the existing palette and
keeping the terminal as the primary surface.

## Local release gates

- [x] Root package, lockfile, desktop runtime, CLI, and packaged app report
      `0.1.0-alpha.4.2`.
- [x] `npm run verify` passes (503 passed, 1 skipped).
- [x] `npm run audit:production` reports no production vulnerabilities.
- [x] `npm run package:check` passes with the exact 11-file allowlist.
- [x] `npm run smoke:packed` passes.
- [x] macOS app, DMG, and ZIP artifacts are built.
- [x] Packaged CLI and Electron PTY smoke checks pass.
- [x] The verified app bundle is installed at `/Applications/Rirei.app` and reports
      `0.1.0-alpha.4.2`.
- [x] SHA-256 checksums are recorded in `dist/SHA256SUMS-0.1.0-alpha.4.2.txt`.

Local artifact checksums:

```text
bccdc35fffd17c11d70e726aa3b7bedf7751f007f291a9e264712a4857992ca7  Rirei-0.1.0-alpha.4.2-arm64.dmg
abc4cb3302025929b2e18a9fc0ce46590227f0b605de57851dacfd5ed639d0dc  Rirei-0.1.0-alpha.4.2-arm64-mac.zip
```

## Proposed feature commits

1. `Added secure Relay Threads and session labels`
2. `Rebuilt the Rirei desktop with the 3a control-room layout`
3. `Added reliable session shutdown and daemon finalization`
4. `Added portable terminal attachment and single-writer control`
5. `Hardened terminal daemon recovery and bridge synchronization`
6. `Prepared Rirei 0.1.0-alpha.4.2 for release`

## Publication gates

- [ ] Release-relevant changes are reviewed and committed without unrelated local fixtures or
      databases.
- [ ] GitHub CI passes on Windows, macOS, and Linux for the final release commit.
- [ ] Native Windows Terminal acceptance covers launch, mouse input, attach/detach, resize, and
      shutdown.
- [ ] Tag `v0.1.0-alpha.4.2` is created only after the final commit passes CI.

## Distribution boundary

The npm package remains private. Current macOS artifacts are unsigned because the available Apple
certificates are expired. Do not attach those artifacts to a public desktop release until a valid
Developer ID Application identity, hardened runtime, notarization, stapling, Gatekeeper assessment,
and clean-machine installation test are complete.
