# Contributing to Rirei

Rirei is an early-stage local orchestration tool. Discuss large protocol, persistence, provider,
or UI changes in an issue before implementation.

## Development

Requirements: Node.js 22+, npm, Git, and macOS for Electron/PTy-specific verification.

```sh
npm ci
npm run verify
npm run audit:production
npm run package:check
```

## Expectations

- Keep provider-specific behavior behind an adapter or structured provider host.
- Do not infer permissions, usage limits, or completion from untrusted terminal text.
- Preserve the one-writer-per-worktree invariant.
- Do not add automatic commit, push, reset, merge, clean, or destructive cleanup behavior.
- Keep credentials, transcripts, terminal output, local paths, and generated `.relay/` state out
  of Git and public fixtures.
- Update tests and documentation with behavioral changes.
- Keep the scriptable `relay` command noninteractive unless a subcommand explicitly owns input.

By contributing, you agree that your contribution is licensed under the repository's MIT
license.
