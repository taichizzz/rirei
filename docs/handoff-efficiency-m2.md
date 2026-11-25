# Handoff efficiency: M2 milestone

Status: **M2 complete and offline-qualified; M3 next.**\
Date: 2026-11-07\
Plan: [handoff-efficiency-plan.md](handoff-efficiency-plan.md).

Subsequent progress: [M3 implementation and qualification](handoff-efficiency-m3.md). The
M3-next decision below records the state at completion of this earlier milestone.

## Scope and decision

M2 adds versioned covered-input identities and host-observed verification receipts to the
unreleased working-copy CLI. Handoffs distinguish historical, pending, stale, and matching
observations. The next milestone is the bounded inspection packet in M3.

No live provider sessions were used. Token savings and continuation-speed improvements remain
unmeasured for M2. The alpha.5.1 downloads do not include this implementation.

## Covered-input identity v1

`src/context/snapshot.ts` produces `rirei-covered-inputs-v1`, separately from the existing
checkpoint fingerprint and run-start Git anchor. Its identity binds:

- Canonical worktree/repository identity, HEAD and branch.
- HEAD tree entries and the exact staged index representation, including index stages/flags.
- A sorted manifest of tracked and nonignored untracked paths, actual content hashes, modes,
  and file kinds. HEAD-tracked paths remain covered after removal from the index.
- Dependency manifests, lockfiles, and runtime-version files through a separate dependency digest.

This detects same-name untracked edits, staged/unstaged cancellation, renames, deletion, mode
changes, and same-size edits with restored modification times. It does not use mtime/size as a
content cache. Paths use NUL-delimited Git output; invalid path encodings make coverage partial.
Inherited `GIT_*` variables cannot redirect inspection to another index or worktree.

The inspector excludes `.relay`/`.git` recorder metadata, including accidentally tracked recorder
files. Sensitive filenames such as `.env`, `.npmrc`, credential files, and private-key files are
not content-read. Leaf symlink metadata is hashed without following the target; ancestor links
are rejected. Index/tree entries bind pinned gitlink commits; checked-out submodule commits and
nested dirty contents remain explicitly unmeasured. These gaps,
unmerged/sparse indexes, unreadable files, and exhausted limits prevent complete coverage.

| Bound                      |   Default |
| -------------------------- | --------: |
| Files                      |     2,000 |
| Bytes per regular file     |     1 MiB |
| Bytes per content scan     |    16 MiB |
| Output per Git command     |     2 MiB |
| Entire inspection deadline | 3 seconds |

Two consecutive content scans must agree, with Git metadata checked around each scan. One
additional scan can recover a changed boundary; three scans without agreement produce
`unstable`. Deadlines produce `partial` or `unavailable`, rather than a complete identity.
Omission details are bounded. This observation mechanism is not a filesystem sandbox or a
proof that no transient mutation occurred between observations.

`coverage.status: complete` means the declared **tracked and nonignored untracked file scope**
was observed consistently. Ignored/generated inputs and the test environment remain separate,
explicitly unqualified inputs.

## Receipt lifecycle

`relay finish --run-tests` persists a pending receipt before launching the configured command.
The command still runs through the existing shell with inherited stdio. Completion adds:

- Command text/digest, working directory, task/receipt IDs, and configured-test scope.
- Observed exit, start/end timestamps, and host-monotonic command duration.
- Start/end covered-input and environment identities.
- A canonical content-integrity hash.

Recognized command secrets are redacted before hashing; command text is capped at 4,096
characters with redaction/truncation flags. Output remains `not-captured`; neither output bytes
nor an output hash is invented. Node version/platform/architecture and an executable-path digest
are recorded; installed dependency contents and external test-tool versions remain unmeasured.

The environment allowlist is `NODE_ENV`, `TZ`, `LANG`, `LC_ALL`, and `CI`. Only conventional
development/production/test modes, recognized time zones, bounded locale forms, boolean CI
values, and empty values are retained. Nonstandard, control-containing, oversized, or recognized
secret values retain presence/withheld flags only. No arbitrary environment variables or secret
value hashes are recorded. Environment coverage is always `partial` in the current CLI.

Observed nonzero exits remain failed results and block task completion. Spawn errors and signal
exits retain interrupted receipts with unknown results. If the controller dies before recording
completion, its durable receipt stays pending. No automatic replacement, recovery, or historical
command execution is introduced.

Receipts are optional additive schema-v8 state fields, capped at 64. Retention removes old
nonpending receipts first and never silently prunes pending receipts; a full pending ledger
refuses another launch. Linked legacy test entries remain readable. Older state/migrations do
not synthesize stronger identities or promote old results. A content hash detects changed bytes
when the recorded hash no longer matches; it does not authenticate authorship or protect against
someone rewriting local state and its hash.

## Freshness and retrieval

| State                 | Interpretation                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| `historical`          | Legacy/assistant-only, incomplete, interrupted, integrity-failed, or insufficiently covered evidence   |
| `pending`             | A durable start exists; no complete result was observed                                                |
| `stale`               | Configured command, covered code/workspace, or observed environment changed, including during the test |
| `current-observation` | Matching covered boundaries and an observed result; environment and the interval remain unqualified    |
| `reuse-eligible`      | Reserved classifier result requiring an explicit trusted deterministic host qualification              |

The classifier's trusted fixture qualification must bind receipt, command, snapshot, and
environment identities and explicitly cover dependencies, ignored inputs, environment/toolchain
inputs, external state, clock, randomness, and a sealed interval. Failed, redacted, truncated, or
withheld-environment evidence cannot qualify. **No current CLI accepts or creates this
qualification, and tests are never automatically skipped.**

```sh
relay context verification
relay context verification --receipt <receipt-uuid>
```

Both commands are read-only, return `automaticTestReuse: false`, and work after task completion.
The default returns at most 64 freshness summaries plus the current covered identity/environment
when relevant. `--receipt` includes one retained receipt from the current task. Managed readers
use existing task/capability/consent checks. A receipt from another worktree stays historical
evidence and cannot verify the current worktree; its directory is not execution authority.
Clearing captured hook context preserves these task-state receipts.

Compact handoffs include the latest verification freshness and observed exit when budget permits.
Matching observations explicitly leave the environment unqualified; stale observations do not
verify current inputs. Receipt changes and current covered-input changes invalidate switch
previews. An approved complete identity is checked again after provider setup and immediately
before process launch. Storage-only state revisions remain acceptable.

## Offline qualification

The clean local verification checkout passed:

- `npm run verify`: TypeScript, ESLint, formatting, build, **768 passed / 3 skipped**.
- All six frozen interruption fixtures: references pass and interrupted inputs are rejected.
- Offline two-way workflow validation: both reference implementations pass all seven groups;
  unfinished snapshots are rejected; fixture hashes remain unchanged.
- Package contents verified against the existing 13-file allowlist.

The 36 added regressions cover content/index identity, unusual paths, ignored/sensitive inputs,
symlinks/gitlinks, limits/deadlines/concurrent edits, pending/completed/interrupted persistence,
legacy migrations, integrity failures, retention, command/runtime/environment differences,
source/compiled lookup, consent/worktree boundaries, preview/launch invalidation, and injected
synchronous/asynchronous spawn errors and signal exits. All provider-process tests use fixtures.

### Local snapshot overhead

[Retained numeric samples](../benchmarks/continuity/reports/m2-snapshot-timing.json) record 12
sequential observations per local fixture on macOS ARM64 / Node 22.14.0. Each sample includes
both full content scans. The filesystem cache was warm; Node startup and full handoff preparation
are excluded.

| Fixture                            | Files |   Bytes |     Median | Descriptive nearest-rank p95 |
| ---------------------------------- | ----: | ------: | ---------: | ---------------------------: |
| Initial tenant ledger              |     6 |   1,163 |  67.368 ms |                    75.540 ms |
| Ledger plus 256 fixed 2 KiB inputs |   262 | 525,451 | 185.927 ms |                   205.013 ms |

These small local observations do not qualify the plan's full preparation-latency target or
native Windows behavior. M3 should reuse the consistent snapshot when assembling its packet
and measure the complete preparation path. Broader model-quality/efficiency evaluation remains
subject to a separately authorized live budget.
