# Rirei 0.1.0-alpha.5.5

This CLI alpha adds an opt-in way to recover an interrupted coding task. Start with Claude Code,
then hand the task to another installed agent with the latest requirements and relevant evidence.

## What changed

- **Task-local capture.** Enable it per task with `relay context enable`. New managed Claude Code
  runs retain bounded, sanitized submissions and visible tool outcomes. Handoffs prioritize exact
  user instructions and flag any retained text the receiving agent must look up.
- **Verification freshness.** `relay finish --run-tests` records the configured test command and
  observed result. `relay context verification` and the handoff show when the covered inputs no
  longer match. Rirei never skips tests automatically based on an earlier result.
- **Inspect and retrieve.** `relay context inspect` shows requirements, current changes, and
  verification in a bounded response. Use `context evidence`, `find`, `read`, and `batch` to
  retrieve specific records or snapshot-bound file windows without rereading everything.
- **Handoff previews.** `relay handoff --profile` lets you compare focused output guidance and
  stable prompt layouts. These experimental profiles apply to previews only.

## Try an interrupted handoff

In a Git workspace with an active task and the providers installed and signed in:

```sh
relay context enable
relay run claude
# After the Claude run stops:
relay handoff
relay switch codex
```

Review and approve the handoff before the next provider starts. Capture is off by default and
does not import existing provider conversations. Interactive Codex capture is not included.
`relay context disable` stops capture and excludes the retained evidence from handoffs;
`relay context clear` also removes this task's captured records. Token analytics uses its own
opt-in setting.

## Update from alpha.5.1

Stop active Relay terminals before upgrading. Download `taichizzz-rirei-0.1.0-alpha.5.5.tgz`
and `SHA256SUMS.txt` from the GitHub release. Verify the download against the provided checksum.
The CLI requires Node.js 22.12 or newer and Git.

- **Windows:** download `install-windows.ps1` from this release and rerun it with
  `-Version 0.1.0-alpha.5.5 -PackageFile .\taichizzz-rirei-0.1.0-alpha.5.5.tgz`. Use the same
  installation prefix if you set a custom `-InstallRoot`.
- **macOS or Linux:** run `npm install --global ./taichizzz-rirei-0.1.0-alpha.5.5.tgz` using
  the same npm prefix as your previous install.

Check `relay --version` and `relay doctor --installation` afterward. The upgrade retains existing
tasks, settings, and token preferences. This GitHub prerelease distributes the CLI and Windows
installer; installation of the tarball does not require Rirei to be published to the npm registry.

## Benchmark status

The live smoke tests verified handoff completion on the tested checkpoints. In the single live
comparison with T3 Code, both tools produced identical code and verified it. T3 Code finished
sooner on that task; Rirei reported fewer non-cached tokens with different cache reuse. The result
does not establish general speed or token savings.

[CLI reference](https://github.com/taichizzz/rirei/blob/v0.1.0-alpha.5.5/docs/cli-reference.md) ·
[Windows installation](https://github.com/taichizzz/rirei/blob/v0.1.0-alpha.5.5/docs/windows-install.md) ·
[Live head-to-head results](https://github.com/taichizzz/rirei/blob/v0.1.0-alpha.5.5/benchmarks/continuity/reports/t3-live-head-to-head-2026-11-25.md)
