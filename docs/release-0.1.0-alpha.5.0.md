# Rirei 0.1.0-alpha.5.0

This alpha adds machine-wide token analytics and usage-limit-aware provider handoffs.

## Token usage

- A dedicated desktop Usage view shows token history across Claude Code, Codex, Gemini,
  Antigravity, and OpenCode, including sessions started outside Rirei.
- Seven-, thirty-, and ninety-day filters cover agent rankings, daily charts, model breakdowns,
  token components, and recent sessions. A separate activity calendar shows thirteen weeks.
- The CLI owns collection through `relay usage tokens`; the TUI shares the same reports and
  can enable analytics and refresh its token view.
- Pinned ccusage 20.0.24 processes local logs offline after consent. Rirei stores sanitized
  usage metadata in a machine-wide, timezone-specific cache.
- Per-agent refreshes preserve the last successful snapshot, coordinate concurrent requests,
  and keep missing data distinct from zero. Cached history supports instant range changes.
- Subscription quota percentages remain separate from token totals. Codex quota collection
  reads active and archived sessions and selects the newest valid capture.

## Handoffs at usage limits

- Fresh structured usage samples help distinguish plan exhaustion and short-window rate
  limiting from an unexplained provider failure.
- Run history, status output, desktop, and TUI show the classified result and reset time.
- Preflight warnings and `--fail-on-exhausted` help avoid launching an exhausted provider.
- Handoff offers suggest installed alternatives while preserving checkpoint creation, preview,
  continuation-note checks, and explicit approval.

## Benchmark tooling

The eight-task harness compares a baseline, a no-notes handoff, and 300/800/2,000-token
handoffs. It records exploration metrics, deduplicates identical prompts, and reports each
budget separately. The expanded protocol has local dry-run coverage; its changes are not a
new claim of measured token savings. The archived paid results remain unchanged.

## Validation

Release checks include the full TypeScript/lint/format/test pipeline, the zero-provider
benchmark, production dependency audit, package-content validation, packed daemon/PTY smoke,
and macOS desktop CLI/PTY smoke. GitHub CI covers Windows, macOS, and Linux.

## Distribution

This is a source-only GitHub prerelease, matching alpha.4.2. The npm package remains private.
Local macOS builds can be ad-hoc signed for testing. Public desktop downloads require a valid
Developer ID signature, notarization, stapling, Gatekeeper assessment, and clean-machine
testing, as documented in [Publication](publication.md).
