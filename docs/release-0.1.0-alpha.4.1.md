# Rirei 0.1.0-alpha.4.1 release preparation

Status: release candidate prepared and validated locally.

## Release summary

This alpha hardens the cross-platform terminal control room introduced in alpha.4. Desktop now
guides first-run project and provider setup, while desktop and TUI launches expose discovered
models, model-specific effort levels, provider defaults, and custom model IDs. Usage views report
remaining capacity with exact capture/reset timestamps and distinguish stale data, collector
failures, unsupported providers, and not-yet-collected sources.

Terminal ownership is more conservative under concurrent startup, shutdown, and bridge recovery.
Packed installs include the lifecycle helpers required by detached Codex and OpenCode launches,
and Windows helper processes no longer create incidental console windows.

## Local release gates

- [x] `relay --version` reports `0.1.0-alpha.4.1`.
- [x] `npm run verify` passes (390 passed, 1 skipped).
- [x] `npm run audit:production` reports no production vulnerabilities.
- [x] `npm run package:check` passes with the exact eight-file allowlist.
- [x] `npm run smoke:packed` passes.
- [x] Fresh macOS DMG and ZIP artifacts are built from an empty output directory.
- [x] Packaged CLI starts from an isolated directory without the development `node_modules` tree.
- [x] Packaged desktop PTY smoke passes against the new app bundle.
- [x] SHA-256 checksums are recorded in `dist/SHA256SUMS-0.1.0-alpha.4.1.txt`.

Local artifact checksums:

```text
6b672a3b94126a5332eec2198fb0c15d62c74e27c8647592eaa1310061f7c196  Rirei-0.1.0-alpha.4.1-arm64.dmg
c12530234098287398d29d97ced61af2e0cbbb2984633b9b693a4890d86f2182  Rirei-0.1.0-alpha.4.1-arm64-mac.zip
```

## Publication gates

- [ ] Release-relevant changes are reviewed on a clean branch based on `origin/main`.
- [ ] Unrelated `.prettierignore` and `vitest.config.ts` changes are excluded.
- [ ] GitHub CI passes on Windows, macOS, and Linux for the final release commit.
- [ ] Security checks pass for the final release commit.
- [ ] Native Windows Terminal acceptance covers launch, mouse input, attach/detach, resize, and
      shutdown.
- [ ] Tag `v0.1.0-alpha.4.1` is created only after the final commit passes CI.

## Distribution boundary

The npm package remains private. Current macOS artifacts are unsigned because the available Apple
certificates are expired. Do not attach those artifacts to a public desktop release until a valid
Developer ID Application identity, hardened runtime, notarization, stapling, Gatekeeper assessment,
and clean-machine installation test are complete.

Verified usage collection currently exists for Claude and Codex. Gemini, Antigravity, and OpenCode
remain explicitly unsupported rather than displaying inferred quota values.
