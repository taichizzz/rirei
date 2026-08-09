# Worktree workspaces

Rirei lets several agents work in one repository at the same time by giving each an isolated
Git branch and linked worktree, instead of sharing one working tree. This is the only place
Relay mutates Git, and it does so only through the explicit `relay workspace create` action.

## Model

```ts
interface RelayWorkspace {
  id: string;
  parentTaskId: string;
  repositoryRoot: string; // canonical (symlink-resolved) top level
  worktreePath: string; // outside the repository
  branch: string; // rirei/<slug>-<role>-<id>
  baseCommit: string;
  role: 'implement' | 'review' | 'verify' | 'investigate';
  createdAt: string;
  status: 'creating' | 'ready' | 'active' | 'completed' | 'cleanup_available';
  terminalIds: string[];
}
```

Workspaces are recorded in `.relay/workspaces.json` (schema `1`), validated by
`src/worktrees/schema.ts`.

## Storage

Worktrees live outside the repository so a linked worktree never nests inside `.git` or shows
up in the main repository's status:

```
<data home>/worktrees/<repository-key>/<workspace-id>/
```

The data home resolves in order: `RIREI_DATA_HOME` (override / test hook) →
`$XDG_DATA_HOME/rirei` → `~/.local/share/rirei` (`src/worktrees/data-dir.ts`). The
`repository-key` is a stable hash of the canonical Git root and the `origin` remote
(`src/worktrees/identity.ts`) — a directory key only, never a security boundary.

## Creation flow

`createWorkspace()` (`src/worktrees/manager.ts`) follows the previewed flow under the
repository writer lock:

1. Validate the repository, branch, and base commit (an unborn repository is rejected).
2. Compute the workspace id, branch, and worktree path (`previewWorkspace()`), with no side
   effects — a frontend can show this for approval and then execute exactly what was shown via
   `createWorkspaceFromPreview()`.
3. Acquire the repository writer lock.
4. Verify that neither the branch nor the path already exists.
5. Run `git worktree add -b <branch> <path> <base-commit>` with an argument array.
6. Append the workspace to the registry and record a `workspace_created` event.
7. Release the lock.

If a step fails after the worktree is created, the error reports exactly what exists. Relay
never silently deletes a partially created worktree, because it may already hold work.

## Manual cleanup

Cleanup is a separate, inspection-only action (`inspectWorkspaceCleanup()` /
`relay workspace cleanup <id>`). It reports:

- whether the worktree still exists;
- dirty and untracked files in the worktree;
- commits ahead of the base commit;
- unpushed commits, when an upstream is configured;
- attached terminals.

A workspace claimed by an active run lease is always blocked: the run must exit (or be recovered
with `relay recover --force`) before cleanup is even considered. See
[state-and-events.md](state-and-events.md#run-leases).

Inspection fails closed: a missing/replaced worktree, detached or unreadable Git state, an
unknown base comparison, or unreadable Relay state is itself a cleanup blocker.

It then prints copyable `git worktree remove` / `git branch -d` commands and marks cleanup
**blocked** when running removal now would lose work. Relay does not run the commands: automatic
`git worktree remove` is deferred until these checks and confirmations are proven, and force
removal is never a default.

## What Relay never does

Merge, reset, rebase, push, clean, force-checkout, force-delete, or delete a worktree or branch.
See [security.md](security.md#git-safety).
