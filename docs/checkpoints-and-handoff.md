# Checkpoints and handoff

These are the two mechanisms that make a task portable between agents. **Checkpoints** are
deterministic Git+state snapshots on disk; the **handoff** is a compact text summary built
from structured state. Both are produced by `src/lifecycle.ts` and both deliberately avoid
storing or forwarding the full diff by default.

## Checkpoints

`createCheckpoint(root, state, label?)` backs `relay checkpoint`, and also runs inside
`relay switch` (label `Switch to <agent>`) and `relay finish` (label `Final`).

### Git snapshot

`inspectGitSnapshot(root, maxPatchBytes)` (`src/git/repository.ts`) collects, with the
`.relay/` directory excluded via `:(exclude).relay/**`:

- `git status --porcelain=v1 --untracked-files=all`
- `git diff --stat`
- `git diff --binary` (the patch)

The diff base is `HEAD`, or `--cached` when the repository has no commits yet (`unborn`).

### On-disk layout

```
.relay/checkpoints/<id>/
├── metadata.json     # schemaVersion, id, createdAt, label?, commit, branch, patchTruncated
├── status.txt        # porcelain status
├── diff-stat.txt     # diff --stat output
└── changes.patch     # bounded binary patch
```

The checkpoint `id` is derived from the creation timestamp plus a zero-padded sequence
number, e.g. `2026-07-12T00-00-00-000Z-001`. Directories are `0700`; files are `0600`.

### Patch bounding

`changes.patch` is truncated to `checkpoint.maxPatchBytes` (default 1,000,000). When the
patch exceeds the budget it is cut and a `[Relay patch truncated]` marker is appended, and
`metadata.patchTruncated` is set to `true`.

### Retention

After writing, checkpoints are pruned to `checkpoint.maxCount` (default 20). The oldest
directories beyond that count are removed (`rm -rf` on the specific checkpoint paths, always
inside `.relay/` via the path policy).

### What checkpoints do **not** store today

- Captured test output (`test-output.txt`) — reserved; `maxTestOutputBytes` is unused.
- A per-checkpoint `handoff.md` — the handoff is produced separately by `relay handoff`.

## Handoff

`renderHandoff(root, state)` builds a plain-text, provider-independent summary and is printed
by `relay handoff` and previewed by `relay switch`.

### Current section layout

```
# Relay handoff: <task title>

<original request>

Status: <status>
Git: <branch> at <commit>
Changed files:
<porcelain status or "(clean)">
Diff stat:
<diff --stat or "(none)">
Completed:
- <items or "None recorded">
Remaining:
- <items or "Refer to original request">
Decisions:
- <items or "None recorded">
Tests:
- <status>: <command>   (or "None recorded")
Continue from the current working tree. Do not discard existing changes.
```

The text is truncated to `handoff.maxCharacters` (default 24,000) with a
`[Relay handoff truncated]` marker if needed.

### Why the full diff is excluded

The next agent is expected to **inspect the repository and `git diff` directly**. Embedding
the entire diff would waste tokens and duplicate what the agent can read from the working
tree. The handoff therefore carries the goal, status, changed-file list, and a diff _stat_ —
enough to orient, not to re-read the whole change.

### Known gaps vs. the intended format

The target handoff (from the project brief) also includes **Requirements**, **Constraints**,
**Blockers**, **Current errors**, **Questions requiring human input**, and a numbered
"Instructions for the next agent" block. The state schema already holds requirements,
constraints, decisions, and blockers, but `renderHandoff` does not emit all of them yet. If
you extend the handoff:

1. Add the missing sections in `renderHandoff` (`src/lifecycle.ts`).
2. Cover the new output with a golden-file test.
3. Update the "Current section layout" above so the docs stay in sync.
