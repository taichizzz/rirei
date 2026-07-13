# Security and safety

Relay is built on the assumption that a repository may contain misleading or malicious
content, and that provider credentials must never pass through Relay. This document collects
the guarantees and the code that enforces them.

## Authentication boundary

Relay does **not**:

- authenticate with Claude Code, Codex, or Gemini on your behalf;
- read or copy provider credential files;
- extract or reuse OAuth tokens between applications;
- treat a subscription as a general-purpose API key;
- attempt to bypass provider usage limits.

Each official CLI owns its authentication, billing, rate limits, model availability, and
permissions. Relay only launches the executable and passes a prompt argument. This is why
`detectAuthentication()` returns `unknown` rather than `ready` — Relay refuses to inspect
credentials, so it cannot assert they are valid. See [agents.md](agents.md).

Relay switches to a _separately authenticated_ provider when one is unavailable; it is not a
way around any provider's limits.

## Git safety

Relay treats Git as shared project memory but never mutates it. It does not:

commit · push · merge · reset · rebase · clean · force-checkout · discard uncommitted changes ·
create branches or worktrees.

Enforcement is structural: the only Git commands Relay runs are read-only inspections in
`src/git/repository.ts` (`rev-parse`, `status`, `branch --show-current`, `diff`). There is no
code path that writes to the repository.

Supporting behaviors:

- **Dirty-tree warning.** `relay start` refuses to begin on a dirty working tree unless
  `--allow-dirty` is passed, and records `dirtyAtStart` so pre-existing changes are
  distinguishable from task changes.
- **Unborn repositories.** When there is no `HEAD` yet, snapshots diff against `--cached`
  instead of `HEAD`, and the commit is recorded as `unborn`.
- **Detached/no branch.** `inspectGitBaseline` requires a checked-out branch and errors
  otherwise, avoiding ambiguous state.

## Path confinement

Every path Relay writes goes through `relayPath()` (`src/safety/path-policy.ts`), which
resolves the target and throws if it would fall outside `.relay/`:

```ts
if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
  throw new Error('Relay state paths must remain within .relay.');
}
```

This blocks path traversal (`../`) in checkpoint ids, temp filenames, and any other computed
path. Checkpoint pruning also deletes only paths resolved through this policy.

## Local state permissions

- `.relay/` and its subdirectories are created with mode `0700`.
- `state.json`, `config.json`, event log, and checkpoint files are written `0600`.
- State writes are atomic (temp file + `rename`) so interruption cannot corrupt state — see
  [state-and-events.md](state-and-events.md).

## Subprocess hygiene

- Provider CLIs and Git are invoked with **argument arrays**, never shell-interpolated
  strings, so repository-controlled text cannot inject shell commands. (The one shell use is
  `relay finish --run-tests`, which runs the _user-configured_ `tests.command` you set
  yourself in `config.json`.)
- Interactive agents inherit stdio (CLI) or run under a PTY (desktop); Relay does not capture
  or persist the full terminal session by default.
- The desktop app runs its renderer with `contextIsolation: true`, `nodeIntegration: false`,
  and `sandbox: true`, exposing only a small `window.relay` bridge. See [desktop.md](desktop.md).

## Secrets

The strongest protection is that Relay avoids collecting secrets at all: it stores Git
metadata, status, diff stats, and a bounded patch — not environment variables, not
credential files, not raw conversations.

> Note on the bounded patch: `changes.patch` is a real `git diff` of your working tree. If
> you have staged/unstaged secrets in tracked files, they can appear there like in any diff.
> A dedicated redaction pass over stored output (planned as `src/safety/redaction.ts` in the
> original design) is **not yet implemented**. Until it exists, treat `.relay/checkpoints/`
> as you would any local diff, keep it git-ignored, and don't check working-tree secrets in.

## What belongs in version control

- **Ignore:** generated event logs, checkpoints, captured output — anything under
  `.relay/checkpoints/`, `.relay/test-output/`, and `.relay/events.jsonl`.
- **Optionally commit later:** human-authored task and decision files, deliberately.

`relay init` prints this guidance when it sets up the directory.
