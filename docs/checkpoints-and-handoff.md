# Checkpoints and handoff

These are the two mechanisms that make a task portable between agents. **Checkpoints** are
deterministic Git+state snapshots on disk; the **handoff** is a compact text summary built
from structured state. Both are produced by `src/lifecycle.ts` and both deliberately avoid
storing or forwarding the full diff by default.

## Checkpoints

`createCheckpoint(root, label?)` backs `relay checkpoint`, and also runs inside
`relay switch` (label `Switch to <agent>`) and `relay finish` (label `Final`).

### Git snapshot

`inspectGitSnapshot(root, maxPatchBytes)` (`src/git/repository.ts`) collects, with the
`.relay/` directory excluded via `:(exclude).relay/**` (and additionally hidden from ordinary
`git status` by the repository-local exclude file — see [Excluding Relay state](#excluding-relay-state)):

- `git status --porcelain=v1 --untracked-files=all`
- `git diff --stat`
- `git diff --binary` (the patch)

The diff base is `HEAD`, or `--cached` when the repository has no commits yet (`unborn`).

### On-disk layout

```
.relay/checkpoints/<id>/
├── metadata.json     # schemaVersion, id, commit/branch, fingerprint, truncation state
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

`renderHandoffDocument(root, state)` builds a versioned capsule plus a compact plain-text,
provider-independent summary. `relay handoff` prints the text; `relay handoff --json` exposes
the capsule, budget metadata, and content checks; `relay switch` previews the same text.

### Default text layout

```
Task: <original request, bounded>

Git: <branch>@<7-char commit>; dirty

Inspect the working tree and preserve existing changes.

Next: <latest unresolved next note>
Blocked: <latest unresolved blocker note> [changed]
Avoid: <latest unresolved rejected note> — <reason>
Decision: <latest unresolved decision note> — <reason>
Question: <latest unresolved question note>
Test: failed <command> — <summary>
Omitted: <count> lower-priority item(s); inspect the working tree if needed.
```

The task request appears exactly once. Notes are newest first within each type and are added in
priority order (`next`, `blocker`, `rejected`, `decision`, `question`, then the latest failed
test); a mandatory latest `next` or `blocker` may be truncated, while lower-priority items are
omitted rather than truncated into fragments. `done` notes,
passed tests, changed-file lists, the full Git fingerprint, and resolved notes stay in the
structured capsule but never appear in the default text. The rendered prompt contains no
note-recording instruction.

The effective ceiling is the minimum of `handoff.maxCharacters` (default 1,200),
`handoff.targetCharacters` (default 1,200), and `handoff.maxTokens` (default 300) times four —
an estimated `characters / 4` per token. The reported `estimatedTokens` is a deterministic
provider-neutral estimate, never an exact provider count. The budget is verified against both
effective ceilings before returning.

### Freshness warnings

Each note is anchored to the commit, branch, and a SHA-256 fingerprint of the Git status plus
the complete tracked/index patch at recording time. `changed` means the branch and commit are
the same but the fingerprint differs; `diverged` means the branch or commit differs. These are
freshness warnings, not semantic proof, and are rendered only when a note is not current. The
fingerprint observes untracked paths through Git status but cannot detect content-only changes
to an already-untracked file.

### Why the full diff is excluded

The next agent is expected to **inspect the repository and `git diff` directly**. Embedding
the entire diff would waste tokens and duplicate what the agent can read from the working
tree. The handoff therefore carries the task, Git anchor, and continuation notes — enough to
orient, not to re-read the whole change.

### Covered verification observations (M2)

The working-copy CLI additionally uses `rirei-covered-inputs-v1` for host-command receipts.
This identity hashes actual tracked/nonignored untracked content and the staged index;
it does not redefine existing checkpoint fingerprints or note anchors. Ignored inputs,
symlinks, submodule checkouts, limits, and environment gaps remain explicitly qualified.

When test records exist, the latest freshness summary can replace the default failed-test
line with `Verification: [historical|pending|stale|current-observation] <command>: <observed exit>`
within the same compact budget. A matching observation leaves the environment unqualified;
a stale one does not verify current inputs. Full summaries stay in `capsule.verification`,
with an optional `coveredSnapshot` in the JSON handoff. `relay context verification --receipt
<id>` retrieves one retained current-task receipt without running its command.

Receipt/current-input changes invalidate an approved switch preview. An approved complete
input identity is checked again immediately before provider launch. No automatic test omission
is enabled. See [M2 milestone notes](handoff-efficiency-m2.md) for limits and offline qualification.

### On-demand inspection packet (M3)

Enabled continuity handoffs additionally expose `inspection` in their JSON envelope and offer
`relay context inspect --snapshot <id>` when space permits after whole submitted instructions.
The anchor and verification classification use the same covered scan. The lookup remains inside
the existing 6,000-character evidence budget, with its own omission count if it cannot fit.

Inspection returns bounded requirements, staged/worktree file states, source display hunks,
verification freshness, and explicitly recorded actions. Current code bytes come from the stable
covered scan; historical text is resolved by immutable Git object ID. Code excerpts stay on demand.
See [M3 milestone notes](handoff-efficiency-m3.md) for the full response and freshness contract.

### Continuation gate

`relay switch` refuses to launch when no unresolved `next`, `blocker`, `rejected`, `decision`,
or `question` note exists, because such a handoff carries only Git-recoverable context. The
interactive preview says so explicitly and offers a chance to record a note; non-interactive
launch fails unless the explicit `--allow-empty-notes` override is provided. This is separate
from the `--yes` launch-approval flag.

### Excluding Relay state

Relay adds one root-anchored line, `/.relay/`, to the repository-local Git exclude file
(`git rev-parse --path-format=absolute --git-path info/exclude`) so `.relay/` never
appears in ordinary `git status`. The helper runs during `relay init` (before any durable state
is written) and repairs older initialized repositories on their next stateful command. It
preserves existing exclude contents and the file mode, is idempotent, supports linked
worktrees, and uses the unresolved Git path plus an atomic replacement so it refuses to follow
a symlinked or non-regular exclude file. Tracked `.gitignore`
files, the index, remotes, and branches are never modified. This local metadata exclusion is
the only Git mutation Relay performs besides creating worktrees.

This describes Rirei's intended project operations. Git itself can refresh internal stat/index
cache metadata during a logically read-only query. Source arrays and `--no-ext-diff` avoid generic
shell interpolation/external diff execution; they do not provide an OS sandbox for Git or providers.

### Known gaps

- Provenance is declared by the `relay note` caller; Relay does not inspect a provider
  transcript to authenticate who originated a semantic claim.
- Note capture happens at the source of the work (for example via `relay note import`); Relay
  cannot guarantee that every agent records notes.
- Requirements, constraints, and captured error output are not yet first-class rendered
  sections. Tests are included only when Relay has a structured test result.
