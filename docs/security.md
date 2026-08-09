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
permissions. Relay launches the executable with explicit argument arrays and, where documented,
a generated session-only settings file for sanitized usage collection. This is why
`detectAuthentication()` returns `unknown` rather than `ready` — Relay refuses to inspect
credentials, so it cannot assert they are valid. See [agents.md](agents.md).

Relay switches to a _separately authenticated_ provider when one is unavailable; it is not a
way around any provider's limits.

Permission approval is not active in the current release. Its future local command channel
is specified in [approval-protocol.md](approval-protocol.md): loopback-only, bearer
authenticated, terminal-owned, expiring, one-shot, and fail-closed. Commands and paths needed
for an informed approval remain transient and never enter the public activity snapshot or
durable Relay state.

## Git safety

Relay treats Git as shared project memory. It performs **exactly one** kind of Git mutation,
and only through an explicit, previewed user action. Distinguish three categories:

1. **Read-only inspection** — the default. `rev-parse`, `status`, `branch --show-current`,
   `diff`, `worktree list`, `show-ref`, `rev-list --count` in `src/git/repository.ts`. These
   never write to the repository, and every read-only command (`status`, `checkpoint`,
   `handoff`, cleanup inspection) stays in this category.
2. **User-approved workspace creation** — `relay workspace create` runs a single mutating
   command, `git worktree add -b <rirei/…branch> <path> <base-commit>` (`addWorktree`), to
   give a concurrent agent an isolated branch and linked worktree. It is previewed, additive,
   and never touches the main working tree.
3. **Explicit manual cleanup** — `relay workspace cleanup <id>` **inspects** a worktree and
   prints copyable `git worktree remove` / `git branch -d` commands. Relay does not run them;
   removal stays in the user's hands in this release.

Operations Relay still **never** performs, automatically or otherwise:

commit · push · merge · reset · rebase · clean · force-checkout · force-delete ·
discard uncommitted changes · delete a worktree or branch.

Worktrees are stored outside the repository (under the Rirei data home, default
`~/.local/share/rirei/worktrees/`), so a linked worktree never nests inside `.git` or appears
in the main repository's status. The repository key that namespaces them is a stable directory
key derived from the canonical root and remote — never a security boundary.

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
- `state.json`, `config.json`, activity source files, and checkpoint files are written `0600`.
- State writes are atomic (temp file + `rename`) so interruption cannot corrupt state — see
  [state-and-events.md](state-and-events.md).
- Authoritative task-state mutations and task replacement are serialized by a
  repository-scoped writer lock. State carries a monotonic `revision`, and guarded operations
  can supply an operation ID or expected revision to reject retries and stale writes.
  Migrations back up the pre-migration file before the first upgraded write, and a
  newer-than-supported `schemaVersion` is refused rather than opened.

## Subprocess hygiene

- Provider CLIs and Git are invoked with **argument arrays**, never shell-interpolated
  strings, so repository-controlled text cannot inject shell commands. (The one shell use is
  `relay finish --run-tests`, which runs the _user-configured_ `tests.command` you set
  yourself in `config.json`.)
- Interactive agents inherit stdio (CLI) or run under a PTY (desktop); Relay does not capture
  or persist the full terminal session by default.
- Searchable history contains Relay task/run metadata only. It does not index provider
  conversations or terminal output.
- Claude usage collection stores only sanitized percentages, reset epochs, and a capture time
  under `~/.relay/provider-usage/`; it does not read credentials or make provider API calls.
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

- **Ignore:** the complete generated `.relay/` directory and the global sanitized Rirei
  activity snapshot. `.relay/` may contain local paths, task text, run metadata, checkpoints,
  patches, and captured test output.
- **Optionally commit later:** separately designed human-authored project files that do not
  share the generated `.relay/` namespace.

`relay init` prints this guidance when it sets up the directory.
