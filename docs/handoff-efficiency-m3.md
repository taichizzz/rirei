# Handoff efficiency: M3 milestone

Status: **M3 complete and offline-qualified; M4 next.**\
Date: 2026-11-07\
Plan: [handoff-efficiency-plan.md](handoff-efficiency-plan.md).

Subsequent progress: [M4 implementation and qualification](handoff-efficiency-m4.md). The
M4-next decision below records this earlier milestone's completion state.

## Delivery

M3 provides one bounded, read-only inspection response combining retained requirements,
current changed-file state, code excerpts, verification freshness, and explicitly recorded
next actions/blockers. It is local, unreleased functionality. The public alpha.5.1 downloads
do not contain it.

```sh
relay context inspect
relay context inspect --format json --max-characters 6000
relay context inspect --snapshot <covered-snapshot-id> --file src/feed.mjs
relay context inspect --no-code --max-characters 2400
```

The default format is text. The complete response, including metadata, escaping, labels,
budget accounting, and final newline, is capped at **6,000 characters by default**, with a
**12,000-character hard maximum** and 1,200-character minimum request. Counts use JavaScript
UTF-16 string units, consistently with existing evidence budgets; character/4 token estimates
remain estimates. JSON is compactly serialized so formatting whitespace cannot escape the cap.

`--snapshot` requires a matching, complete current covered-input identity. A changed or
incompletely observed workspace produces a clear refusal. `--file` focuses optional code and
file metadata on one relative path while preserving requirement priority; it still validates
the complete declared snapshot scope. Absolute/traversing/recorder paths are rejected.
`--no-code` requests metadata and instructions only.

Operators can inspect active or closed tasks. Managed readers use the existing capability,
task, worktree, and disclosure-consent checks. Disabling capture excludes retained submissions.
The command does not write state, queries, or a persistent source cache.

## Requirement and provenance contract

The packet selects whole original/explicit task fields and captured submissions before optional
verification, actions, file metadata, or code. If all retained text fits, it remains chronological.
Under pressure, newer whole submissions take priority. Any missing text produces an explicit
required-before-editing `relay context task` lookup with paged continuation instructions.
Bounded missing-source references include IDs, sequence numbers, and character ranges; counts
disclose references that did not fit. Truncated/redacted sources and known capture gaps remain
`source-incomplete`, even when all retained text is inline.

The response distinguishes snapshot observations, reported file references, requested paths,
host-command verification, and caller-declared user/agent notes. A missing referenced file is
reported without treating its historical path as read authority. Only unresolved `next`/`blocker`
notes or existing legacy task fields supply actions. A diff never creates an inferred next step.
Absent actions are allowed. Pending/failing receipt summaries receive priority over passing
observations; environment coverage remains unqualified and tests are never automatically skipped.

## Snapshot-bound source context

M3 adds optional derived observations to the M2 scanner without changing the
`rirei-covered-inputs-v1` identity algorithm. Current source bytes come from the same stable
content scans as the identity. Historical HEAD/index text is read by the recorded immutable Git
object IDs, with bounded output and elapsed time. No external diff/textconv filter is invoked.

Changed paths have separate staged and worktree states, including staged/unstaged cancellation.
Raw working-file bytes are compared with Git blobs; clean/smudge or line-ending transformations
can therefore conservatively appear changed. Renames are represented as deletion/addition rather
than inferred semantic relationships.

The selector orders changed hunks before directly cited files. Repeated references are deduplicated.
Current lines already shown in a diff do not receive a duplicate whole-file window. Unchanged
directly cited files get a bounded opening window because the existing event schema supplies a
path, not an authenticated line range. Historical absolute paths and shell strings are not used
to discover files. Static dependency-neighbor crawling is deferred.

Display diffs have source IDs/hashes, line coordinates, layer, and truncation/redaction flags.
They are read-only excerpts, with recognized secrets redacted. A bounded line comparison uses
a limited changed-region display for complex inputs; truncated displays are not complete patches.
Binary/invalid-UTF-8 inputs, oversized source, missing files, symlinks, sensitive paths, submodule
coverage, and exhausted bounds have explicit omissions. Incomplete snapshots get metadata-only
responses and retrieval guidance.

| Additional source-display bound     |                             Limit |
| ----------------------------------- | --------------------------------: |
| Current source bytes per file       |                            64 KiB |
| Retained current source per scan    |                16 files / 256 KiB |
| Historical Git blob output          | 64 KiB per object / 256 KiB total |
| Historical source-read phase        |                    1 second total |
| Display excerpts                    |                                24 |
| Diff hunks per comparison           |                                 4 |
| Display hunk                        |       32 lines / 1,600 characters |
| Unchanged cited-file opening window |       24 lines / 1,600 characters |

The M2 scan retains its three-second deadline and file/byte limits. These bounds apply to input
observation and source retrieval; they do not turn filesystem observations into a sandbox or
prove an absence of transient edits between boundaries.

## Handoff integration and derived cache

Enabled continuity handoffs share one covered snapshot with verification classification and the
inspection anchor. A compact lookup/count/coverage item competes within the existing
6,000-character evidence postlude **after submitted instructions**. Code excerpts stay on demand.
The legacy capsule retains its own configured ceiling; combined prompt bytes and omitted items
remain accounted for. An omitted inspection item is reported through `omittedStateItems`.

`handoff --json` exposes the inspection anchor and covered identity. Existing preview and final
prelaunch checks invalidate changed code, receipts, task instructions, capture history, or consent.
An on-demand lookup rechecks semantic task state, journal/consent, and the configured verification
command before returning its response.

An eight-entry in-memory cache holds derived bounded responses. Its key binds the snapshot,
semantic task state, journal/consent digest, observed environment, configured command, focused
path, format, and budget. Every invocation still observes current file contents and validates
state/history; mtime/size alone never authorize reuse. Incomplete snapshots and unavailable source
results are not cached. Separate CLI processes do not share this cache.

## Offline qualification

The clean local checkout passed:

- `npm run verify`: TypeScript, ESLint, formatting, build, **796 passed / 3 skipped**.
- All six frozen interruption-fixture checks and both offline two-way workflow validators.
- Package contents against the existing 13-file allowlist.
- Packed global CLI install, first-task TUI, daemon/PTY, reinstall, and uninstall smoke.
- Explicit Node-global lint for `benchmarks/continuity/inspect.mjs`.

The 28 new tests cover one-response inspection, separate index/worktree versions, multiple hunks,
source deduplication, deletion/missing paths, binary/large/sensitive/link handling, Unicode and
full-envelope budgets, requirement ordering and source gaps, state/history/consent invalidation,
snapshot-bound source reuse, and source/compiled CLI worktree/consent checks.

### Four saved cases

The read-only replay verified the frozen control's file/history hashes, materialized disposable
repositories, and rebound history only in those copies. All **four saved cases retained 6/6 original
requirements**, both in handoffs and in text/JSON inspection. Each inspection also returned one
changed-source excerpt, with no invented action. Text responses used **2,981–4,266 characters**;
JSON responses used **3,413–4,692**. Every evidence postlude stayed under 6,000 characters.

The initial replay caught a `/var` versus `/private/var` fixture-key mismatch. Canonicalizing the
temporary benchmark root corrected the setup; the original archive was untouched. These are
source-preservation results, not new receiver acceptance or efficiency scores.

### Preparation samples

[Numeric report and as-tested source hashes](../benchmarks/continuity/reports/m3-inspection.json):
12 sequential observations per local fixture, macOS ARM64 / Node 22.14.0, warm filesystem cache.

| Fixture                           | Files | Handoff median / p95 | Inspection median / p95 |
| --------------------------------- | ----: | -------------------: | ----------------------: |
| Tenant ledger                     |     6 |  90.925 / 115.494 ms |      75.339 / 95.053 ms |
| Ledger plus 256 fixed 2 KiB files |   262 | 213.377 / 246.461 ms |    195.165 / 221.468 ms |

These descriptive nearest-rank p95s meet the proposed 250 ms local preparation target for the
declared fixtures. Handoff measurements include legacy Git inspection plus covered scans;
inspection includes fresh scans and task/journal validation, with eligible derived packets
reused after the first call. CLI startup is excluded. Cold disks, larger trees, native Windows,
and end-to-end model continuation performance remain unqualified.

Reproduce without any provider sessions:

```sh
node --import tsx benchmarks/continuity/inspect.mjs
node --import tsx benchmarks/continuity/inspect.mjs --control <private-frozen-control-directory>
```

**Milestone decision:** proceed to M4's exact source windows, bounded batch retrieval, and cursor
invalidation. Live model-quality/token/latency evaluation still requires a separately authorized
budget. M3 used zero live provider sessions.
