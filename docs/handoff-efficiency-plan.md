# Handoff efficiency implementation and evaluation plan

Status: **M0–M5 offline-qualified; E1 correctness smoke passed with helper-routing limits; E2/E3 pending**\
Date: 2026-11-05\
Scope: lower continuation token usage, fewer redundant tool roundtrips, and faster correct
Claude Code ↔ Codex handoffs\
Starting point: the local, unreleased requirement-first continuity prototype

Progress: [M0–M1 implementation and verification notes](handoff-efficiency-m0-m1.md),
[M2 covered-input/verification notes](handoff-efficiency-m2.md),
[M3 bounded inspection notes](handoff-efficiency-m3.md),
[M4 targeted retrieval notes](handoff-efficiency-m4.md), and
[M5 output/layout preparation](handoff-efficiency-m5.md).
Stages after E1 remain planned, not authorized executions.

Evaluation update, 2026-11-18: [E1 used all eight approved receiver launches](../benchmarks/continuity/reports/e1-2026-11-18.md).
Control and candidate each passed 4/4 strict cases. Efficiency targets were not met across
receivers, and native helper PATH shadowing limits lookup qualification. No default was promoted;
E2/E3 and output/layout treatments still require separately agreed execution budgets.

## 1. Objective and decision rule

Reduce the total work required for a receiving agent to complete an interrupted task while
preserving every applicable submitted requirement and accurately representing verification.

The optimization order is:

1. Preserve correctness and explicit user constraints.
2. Make execution and measurement reliable.
3. Reduce unnecessary rediscovery, large evidence reads, and repeated verification.
4. Reduce non-cached input and generated output.
5. Improve completion latency and evaluate cache reuse.

Prompt length is a diagnostic, not the primary objective. A slightly longer, sufficient
handoff can be cheaper than a shorter one that causes extra model/tool turns.

### Proposed promotion targets

These are engineering targets to freeze before the next live evaluation, not measured claims:

| Dimension            | Proposed gate                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Correct completion   | No candidate-only acceptance failure or mandatory-constraint violation relative to the frozen requirement-first control in either direction             |
| Strict success       | No new capture/integrity failures; report infrastructure validity separately from acceptance                                                            |
| Receiver usage       | At least 15% lower median paired non-cached input + output than the requirement-first control, per receiving provider                                   |
| Completion time      | At least 10% lower median paired end-to-end continuation time, per receiving provider                                                                   |
| Tail latency         | Investigate any task-level slowdown above 25%; show the full distribution and descriptive p90 without treating a small sample as a stable tail estimate |
| Preparation overhead | Target p95 below 250 ms on declared small/medium local-repository fixtures; deadline-bounded fallback for large/slow repositories                       |
| Requirement delivery | All mandatory retained text is inline or explicitly marked for required paged retrieval; no silent loss                                                 |
| Efficiency claims    | Compare matched tasks within the same receiver/model/version; require correctness first                                                                 |

If a candidate saves tokens but is slower, report the tradeoff and retain the faster default.
If it improves only one receiving provider, keep the improvement provider-specific until the
other direction is validated. Any acceptance regression blocks promotion of that candidate.

## 2. Evidence that motivates the work

The [latest live retest](../benchmarks/continuity/reports/requirement-first-live-retest.md)
used eight receivers on four saved checkpoints:

| Finding                                                                                       | Implication                                                                           |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Rirei outputs passed 4/4 acceptance cases, versus 2/4 before the requirement-first fix        | Complete submitted instructions are a protected part of the handoff                   |
| Full-history outputs also passed 4/4                                                          | We have not demonstrated a quality advantage over full history                        |
| One Rirei session had disk/read/logging errors; strict successes were 3/4                     | Storage reliability must precede another efficiency claim                             |
| Two clean Claude → Codex pairs used 27.8% fewer non-cached tokens and 3.1% less receiver time | Token reduction does not automatically produce comparable latency reduction           |
| One clean Codex → Claude pair used 4.6% fewer non-cached tokens but 60.0% more time           | More useful context, fewer roundtrips, and output discipline need separate evaluation |
| Both arms received clearer workspace instructions; Codex CLI also changed between pilots      | Historical improvement is not a clean causal estimate of one renderer change          |

The earlier [two-way pilot](../benchmarks/continuity/reports/2026-11-02-bidirectional.md)
showed that optional history retrieval rescued Codex but did not rescue Claude. The plan
must not recreate that dependency by compressing mandatory instructions into vague pointers.

### Existing capabilities versus planned additions

| Capability             | Current local prototype                                                                | Proposed next work                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Submitted instructions | Whole messages prioritized within a 6,000-character evidence postlude                  | Preserve this behavior; add coverage-aware bundling and efficient overflow retrieval |
| Task lookup            | Original task plus paged captured submissions                                          | Bound response size as well as event count; preserve cursor compatibility            |
| Evidence lookup        | Full retained event by ID; history pages by kind/sequence                              | Exact source windows, deterministic find, and bounded batch retrieval                |
| Current workspace      | Canonical workspace and snapshot-bound inspection; historical path previews suppressed | Exact file/source ranges and bounded batched retrieval                               |
| Verification           | Host-command receipts, covered start/end identities, conservative freshness            | Broader environment qualification; any test-reuse experiment remains separate        |
| Repository context     | Bounded on-demand inspection with staged/worktree display hunks and explicit omissions | Extend targeted retrieval and evaluate source-window ablations                       |
| Runtime logging        | Incremental bounded visible-event logging with local preflight and shared budgets      | Use the qualified measurement foundation for later evaluation                        |
| Bidirectional capture  | Native Claude hooks; Codex exec observer in benchmarks                                 | Qualify application-level reverse capture separately from representation experiments |

The command names, types, defaults, and switches below are proposed interfaces unless they
are explicitly described as existing. This document authorizes no live model sessions.

## 3. Design invariants

1. **Preserve submitted meaning.** Keep exact retained wording and chronology. Do not deduplicate
   repeated submissions solely because their text matches, or infer that an old requirement has
   been superseded without supporting source text.
2. **Distinguish instruction from evidence.** Submitted prompts, operator-recorded requirements,
   assistant claims, provider-reported tool outcomes, and host-observed results have different
   provenance. Generated launch prompts must not recursively become new requirements.
3. **Keep unknowns explicit.** Missing exits, interrupted tools, truncated capture, and incomplete
   environment fingerprints do not become passing results or zero cost.
4. **Respect the current workspace.** Historical paths are references, not authority to switch
   directories. Derive current paths from the managed workspace; do not guess a path mapping.
5. **Keep preview and launch consistent.** Existing ownership, consent, and freshness guards
   continue to cover every field that can change a rendered packet or an inspection result.
6. **Bound every response.** Text, raw reads, result count, and runtime have explicit limits,
   with typed omissions and resumable cursors. Complete requirements take priority over extras.
7. **Keep measurement honest.** Preserve every attempt, including errors and missing counters.
   Report all-attempt outcomes alongside clean paired measurements.

The first implementation uses deterministic local transforms. Semantic extraction models,
embeddings, graph storage, additional providers, and a new desktop UI are not prerequisites.
Existing consent, task ownership, checkpointing, and source citations remain the foundation.

## 4. Target architecture

```text
Captured visible evidence + task state + current worktree
                         │
                         ▼
             Consistent snapshot / coverage check
                         │
            ┌────────────┴────────────┐
            ▼                         ▼
   Requirement-first packet     Snapshot-scoped evidence index
   + bounded state overview     + exact text/file windows
            │                         │
            └────────────┬────────────┘
                         ▼
              Preview / freshness guard
                         ▼
                  Receiver launch
                         ▼
     Targeted lookup + relevant verification + completion
```

### Packet structure

Use one structured packet and render it for the CLI. Avoid independently assembling a
legacy summary, a new summary, and an inspection bundle that repeat the same material.

| Section                         | Source                                                   | Delivery policy                                                                          |
| ------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Workspace and snapshot          | Managed workspace and inspected Git state                | Always explicit; long paths may use a lookup reference without ambiguous truncation      |
| Task and applicable submissions | Original task, explicit fields, captured submissions     | Highest priority; exact wording and coverage metadata                                    |
| Current changes                 | Current status and bounded diff metadata                 | Compact, deterministic; filenames alone are not a semantic description of implementation |
| Verification                    | Qualified receipts or clearly labeled historical reports | Latest relevant result, freshness, scope, and unresolved outcomes                        |
| Unfinished work                 | Pending tools and explicitly recorded next/blocker items | Cite observations; do not invent a next step from a diff                                 |
| Supporting evidence             | Journal/source windows                                   | Read on demand; include only bounded high-value context initially                        |

Illustrative proposed metadata:

```ts
interface ContinuationPacket {
  schemaVersion: 1;
  packetId: string;
  workspaceId: string;
  snapshotId: string;
  taskStateDigest: string;
  evidenceDigest: string;
  requirements: {
    inlinedSourceIds: string[];
    requiredSourceIds: string[];
    truncatedSourceIds: string[];
    redactedSourceIds: string[];
  };
  changedFiles: FileSummary[];
  verification: VerificationSummary[];
  pendingSourceIds: string[];
  omissions: Omission[];
  budget: { usedCharacters: number; maxCharacters: number };
}
```

These are presentation/derived data, not a new source of truth. Keep the existing task state
and event journal authoritative. Rebuild derived indexes from their digests when necessary.

## 5. Phase 0 — freeze baselines and measure where effort goes

### Implementation tasks

- Archive the exact requirement-first source, compiled CLI, configuration, and test fixtures
  used as the next control. Verify archive hashes independently of the active checkout.
- Extend the private event timeline with host-observed monotonic offsets for process launch,
  first visible event, each tool start/end, exit, final artifact flush, and grading start/end.
- Normalize tools by stable tool/item IDs; streamed fragments must not double-count calls.
- Record per-tool retained output bytes, command/file references where observable, exit status,
  source lookups, and repeated reads of the same file version.
- Define repeated work narrowly: the same operation on the same content/environment with no
  intervening relevant change. Label necessary rereads separately from likely redundant work.
- Review final claims against actual verification evidence. A passing public test is not a
  substitute for the task's held-out acceptance checks.

### Metrics

| Metric                       | Definition / source                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| Acceptance                   | All frozen behavioral and constraint checks pass                                          |
| Strict success               | Acceptance plus valid execution, intact evidence, and valid capture                       |
| Preparation time             | Snapshot, packet, and retrieval-index preparation, before receiver launch                 |
| Receiver wall time           | Launch through exit, with timeouts and interruptions visible                              |
| End-to-end continuation time | Preparation + launch/receiver + required finalization; report components too              |
| First useful action          | Task-aware offline trace review; an arbitrary first tool call is not necessarily useful   |
| Non-cached usage             | Provider-specific counters normalized without double-counting cache creation or reasoning |
| Tool roundtrips              | Exposed calls/batches and model turns; tool count alone is insufficient                   |
| Retrieval volume             | Bytes returned, relevant records read, repeated requests, and omissions                   |
| Human repair                 | Clarifications/corrections and timed intervention when actually measured; otherwise null  |

For Codex, use emitted total input minus cached input plus output. For Claude, distinguish
fresh input, cache creation, cache reads, and output; normalize total input before subtraction.
Keep reasoning counters separate when already included in output. A cache hit is not a claim
of zero cost. Do not pool provider token units into a dollar or subscription-quota estimate.

### Acceptance gate

- Existing reports replay to the same recorded measurements.
- Known duplicate streamed events count once; missing counters remain null.
- Tool timelines can distinguish long provider thinking from slow local I/O and extra rounds.
- The control archive is available outside disposable temporary directories.

## 6. Phase 1 — reliable local execution and incremental logging

This phase repairs the environment that invalidated one of the latest receiver runs.

### Runtime layout

- Give benchmark workspaces a dedicated local root outside cloud-synced Documents/Desktop
  locations. Reuse `rireiDataHome()` for platform defaults, with an explicit benchmark-root override.
- Resolve the canonical root once and use it consistently in workspace keys, prompts, grants,
  and artifact manifests. Test `/var` versus `/private/var` aliases and Windows path handling.
- Keep active logs local. Archive completed artifacts to durable private storage and verify
  archive hashes before declaring them retained. Temporary directories alone are not an archive.
- Production projects remain in their chosen locations. Expose measured I/O problems and
  support existing explicitly created local worktrees rather than silently relocating a project.

### Preflight and failure handling

- Check available space on both workspace and log/archive filesystems before a batch and
  before each launch. Proposed threshold: at least 2 GiB and at least ten times the configured
  remaining artifact allowance, whichever is larger; record the actual threshold and reading.
- Perform a small write/fsync/read/delete probe in an owned runtime directory. A free-space
  reading alone does not establish that writes work. Check latency with a bounded deadline.
- Load and hash required input files before spending a session. A cloud placeholder that cannot
  be read fails preflight rather than becoming an agent problem.
- Reserve each session durably before spawning. Enforce one aggregate ledger across recovery
  phases; duplicate keys remain forbidden. No automatic replacement of failed attempts.
- Detect logger failures immediately. Stop later launches and request termination of the affected
  benchmark process, preserve its partial artifacts, and mark its outcome infrastructure-affected.
  Production hook capture should remain non-destructive: disclose a gap rather than killing
  a user's interactive coding process because an optional recorder failed.

### Incremental writer

- Extract a single-writer visible-event stream for the benchmark. Append each complete sanitized
  JSON record once instead of serializing and rewriting the entire accumulated trace repeatedly.
- Use a streaming UTF-8 decoder and bounded input-line/queue sizes. Keep partial lines out of
  the committed-record count. Pause stream consumption for backpressure rather than silently
  dropping records or keeping an unbounded array in memory.
- Record received versus durably persisted sequence numbers. Sync at defined checkpoints and
  finalization; disclose any tail not durably published after an interruption.
- Maintain incremental metric accumulators and validate them against a final offline replay.
  Do not weaken the production journal's existing atomicity/integrity behavior as a side effect
  of improving benchmark logging; evaluate journal-storage changes separately if needed.
- Keep private diagnostics bounded and redact recognized secrets; retain visible evidence only.

### Acceptance gate

- Fake-provider failure injection covers `ENOSPC`, partial writes, slow reads, invalid UTF-8,
  abrupt exit, output bursts, and process termination during finalization.
- A logger fault never produces an apparently complete trace or valid strict-success result.
- Log-write work grows approximately with bytes emitted, not the square of event count.
- Recovery preserves the original incident and prior budget usage; archival corruption is detected.

## 7. Phase 2 — trustworthy snapshot and verification identity

**Implemented locally in M2.** See [the milestone notes](handoff-efficiency-m2.md) for the
declared file scope, environment gaps, receipt lifecycle, defaults, and offline qualification.
The current CLI displays freshness and never automatically omits tests.

### Current limitation to address

`inspectGitSnapshot()` hashes commit, branch, status, and the combined tracked patch. It
does not hash untracked file contents. A tracked worktree equal to HEAD can also conceal a
different staged state in a combined diff. Neither representation includes test environment
identity. The current `launchGitFingerprint` is a run-start anchor, not a test-start receipt.

Consequently, existing matching fingerprints must not automatically authorize skipping tests.

### Proposed snapshot identity

- Version the new fingerprint separately from the current one. Preserve interpretation of
  older artifacts; treat missing stronger metadata as unknown coverage.
- Capture HEAD, worktree identity, index state, staged and unstaged changes, and a deterministic
  manifest of relevant untracked files including content hashes and modes.
- Use NUL-safe Git output for paths; handle renames, spaces, Unicode, deletion, executable modes,
  symlink metadata, and submodule states explicitly. Never follow links outside the allowed root.
- Hash applicable configuration/test files and lockfiles. Exclude internal recorder artifacts.
- Put limits on file count, bytes, and elapsed time. If input coverage is incomplete, record which
  categories were not covered and make verification reuse ineligible.
- Detect concurrent edits while building a bundle through before/after identities and stable
  file reads. Retry at most once offline; otherwise mark stale and use ordinary inspection.
- Cache derived summaries only under the complete identity. Metadata-only caches must not
  imply that unchanged mtime/size proves unchanged content.

### Verification receipt

Proposed fields: command/argv or exact configured command, working directory, observed exit,
start/end times, start/end snapshot IDs, runtime/tool versions, dependency/lockfile identity,
declared environment coverage, output source ID/hash, and test scope when actually known.

For environment information, use a documented allowlist of non-secret values or presence
indicators. Do not record credentials or hashes of secret values. Network services, database
contents, wall-clock/randomness, and ignored/generated inputs make a test non-hermetic unless
their inputs are explicitly controlled and identified.

### Freshness states

| State                 | Meaning                                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `historical`          | Result exists, but a qualified test-start/end identity was not observed                                                    |
| `pending`             | Start observed; no complete result                                                                                         |
| `stale`               | Code/config/environment changed, or changed during the test                                                                |
| `current-observation` | Matching covered code identity with an observed result; not proof of unmeasured environment equivalence                    |
| `reuse-eligible`      | Explicitly qualified deterministic scope, complete matching inputs/environment, observed zero exit, no intervening changes |

First ship accurate freshness display. Automatic test omission should be a separate later
opt-in experiment, limited to `reuse-eligible` results. Newly edited code still needs relevant
verification. A failed or missing receipt does not cause arbitrary historical commands to run.

### Acceptance gate

- Editing an untracked file under the same name invalidates identity.
- Staged/unstaged cancellation, config changes, dependency changes, and in-test edits are detected.
- Old records and assistant success claims cannot become `reuse-eligible`.
- Environment-unknown and network-dependent tests are not silently reused.

## 8. Phase 3 — one bounded inspection bundle

**Implemented locally in M3.** See [the milestone notes](handoff-efficiency-m3.md) for the
current command contract, source-display bounds, saved-case replay, and preparation measurements.

### Implemented interface

```sh
relay context inspect --format text
relay context inspect --snapshot <id> --max-characters 6000 --format json
relay context inspect --file src/feed.mjs
relay context inspect --no-code
```

The bundle is assembled locally from the same snapshot used for the handoff. It should answer
the receiver's common first questions without requiring a separate status command, diff command,
several full file reads, and a broad history query.

### Contents and selection

- Workspace, snapshot ID, requirement coverage, and source links.
- Changed-file status/counts and bounded diff hunks, including added/untracked files where captured.
- Small current-file windows around changed hunks and explicitly referenced locations.
- Verification freshness and pending/failing outcomes.
- Explicitly recorded blockers/next actions, labeled by provenance; absence is allowed.
- Omitted files, missing scopes, budget consumed, and targeted continuation commands.

Rank extra code context deterministically: changed hunk → directly cited file/window → bounded
static neighbor if cheaply identifiable. The initial version does not crawl an entire dependency
graph or ask a model to guess file relevance. Include a window once even when multiple events
reference the same file version.

Start with source code excerpts available on demand. Test inline code windows as an ablation;
do not assume that sending more code up front reduces total tokens.

### Budget policy

- Keep the current 6,000-character evidence budget as the first comparison ceiling.
- Account for the legacy capsule and common launch wrapper separately: the current total prompt
  is larger than that evidence postlude. A candidate's packet limit does not silently override
  existing lower user-configured ceilings or hide wrapper bytes from measurement.
- Allocate exact submitted instructions first; the available remainder is shared by current-state
  metadata, verification, and optional windows. Do not reserve a large fixed code allocation
  that forces requirement loss.
- If mandatory text exceeds the ceiling, use explicit paged delivery with source IDs and offsets.
  Mark inspection incomplete until the required text is available; never call an excerpt complete.
- Proposed ordinary inspection response: 6,000 characters default, 12,000 hard maximum;
  callers can request smaller responses. Treat these as tunable starting limits, not token counts.
- Enforce the final serialized/text envelope size, including labels, paths, citations, and cursors.
  Optional context yields first when the envelope is too large.
- Cache the assembled packet/index under snapshot, task-state, and journal digests. Reuse it
  only while all three remain current; preserve the preview/launch freshness checks.

### Acceptance gate

- The four saved cases retain every original requirement with no invented next step.
- A representative first inspection needs one bounded response rather than multiple broad reads.
- Changed/deleted files, large diffs, binary files, and missing files have explicit omissions.
- Slow or oversized repositories get a metadata-only response with required retrieval pointers
  rather than a long blocking scan or a misleading complete bundle.

## 9. Phase 4 — targeted, snapshot-aware evidence retrieval

**Implemented locally in M4.** See [the milestone notes](handoff-efficiency-m4.md) for exact
range semantics, cursor invalidation, batch schema, byte-volume measurements, and offline checks.

### Implemented interfaces

```sh
# Legacy full task/history/evidence commands also remain supported:
relay context evidence <event-id> --start 0 --length 2000
relay context find --file src/feed.mjs --kind tool_result --limit 5
relay context find --command-id <id> --limit 5
relay context read --file src/feed.mjs --start-line 20 --line-count 60 --snapshot <id>
relay context batch --request-file <workspace-relative-query-file>
```

Distinguish an evidence event from a current file read. Event IDs refer to immutable retained
content; file windows require a snapshot or expected content hash and fail clearly when stale.

### Response contract

- Return source ID, digest, provenance, requested versus returned range, and truncation flags.
- Evidence character offsets refer to the retained sanitized UTF-16 text, matching current
  excerpt metadata; adjust boundaries to avoid splitting surrogate pairs and report actual offsets.
- File reads use line ranges plus content hash. Current-file responses and historical-output
  responses carry different types so one cannot be mistaken for the other.
- Return an opaque continuation cursor bound to task, canonical workspace, evidence/snapshot
  digest, filters, and range. A changed query or changed source invalidates the cursor.
- Proposed single-window default: 2,000 characters; hard maximum: 8,000. Proposed batch:
  at most eight queries and 12,000 total response characters, including metadata.
- Batch results use per-item status plus an aggregate cursor; one missing source cannot silently
  omit the remaining requested items. Readers remain task/workspace-scoped.
- Keep full raw retained lookup available explicitly. Offer compact text for agents and stable
  JSON for tools; preserve existing response behavior until a versioned interface is selected.

### Efficient index

Build a derived in-memory/task-local index from the bounded journal: event IDs, exact reported
file paths, tool IDs, command IDs, kinds, and receipt order. Track index version and journal
digest. Do not infer file dependencies from arbitrary shell strings.

No persistent query telemetry is enabled as a side effect of reading. Benchmark instrumentation
can record query IDs/output sizes in its already-authorized private artifacts.

### Acceptance gate

- Windowed and full reads resolve to the same exact source bytes/text and digest.
- Repeated cursors neither skip nor duplicate source content, including Unicode boundaries.
- More than 20 requirements remain reachable; retrieval never conflates an empty page with
  complete history when a continuation cursor exists.
- Cross-workspace IDs, escaping paths, stale snapshots, and corrupt index/journal state fail clearly.
- Tests compare byte volume and tool rounds for targeted retrieval against full-history rereads.

## 10. Phase 5 — output discipline and measured cache reuse

**Candidate preparation implemented locally in M5.** Named rendering profiles, budget-preserving
fallback, balanced experiment planning, and saved-observation analysis are offline-qualified.
Actual output/cache/receiver-time benefit remains unmeasured. See [M5 notes](handoff-efficiency-m5.md).

### Receiver output policy

Use a short provider-neutral instruction to make focused edits, run relevant checks, and finish
with changed behavior, verification, and remaining uncertainty. Do not request a second detailed
handoff summary when the receiver is finishing the task.

Encourage patches where appropriate; do not prohibit full-file replacement when it is the simpler
correct edit. Do not suppress failure diagnostics or impose an output cap that truncates code.
Compare generated output tokens separately from input/retrieval costs.

### Stable layout

- Use deterministic serialization, section labels, source ordering, and whitespace.
- Keep the static instruction prefix stable. Group timestamps, run IDs, transient warnings,
  and other volatile metadata in the runtime section rather than scattering them through the packet.
- Keep workspace authority prominent and unambiguous even when it reduces prefix reuse.
- Do not remove necessary citations or consent/freshness markers merely to increase cache hits.
- Keep initial and retrieved context from needlessly repeating already-inlined material; preserve
  repeated submitted instructions when their chronology matters.

### Cache experiment

Cache reuse across fresh provider sessions is not under Rirei's full control. Use balanced
AB/BA ordering within provider/version and record elapsed spacing, usage counters, and whether
cache creation/read counters were exposed. Do not claim a controlled cold-cache condition unless
the provider offers a documented way to establish it. Do not alter credentials or provider caches.

Test stable-layout/output-policy changes separately from the inspection-bundle change. A cache
hit improvement that increases output, tool rounds, or wall time does not automatically qualify.

### Acceptance gate

- No requirement or uncertainty disappears under output/layout policies.
- Provider usage parsing still separates cache creation, cache reads, output, and reasoning.
- Any claimed cache benefit is observable in counters and repeatable under balanced ordering.

## 11. Phase 6 — integrate the winning design into real switches

- Use `renderHandoffDocument()` as the common packet composition point.
- Keep packet generation provider-neutral; keep launch flags, event mapping, and model/effort
  selection behind the existing provider integration boundaries.
- Carry the packet identity through preview approval and recheck task/journal/worktree freshness
  immediately before launch. New code windows and verification receipts must participate in
  invalidation; live telemetry alone should not unnecessarily invalidate a preview.
- Deliver targeted context through the existing read-only CLI first. Desktop/TUI projections
  can consume the same metadata later without introducing another parallel state model.
- Qualify actual managed Claude → Codex and Codex → Claude application launches separately
  from receiver-only benchmark scaffolding. Native interactive Codex capture is still a distinct
  implementation/qualification task; an exec-stream test is not proof it works interactively.
- Add optional/versioned fields for old state and report readers. Missing new fields mean unknown
  freshness, not reconstructed certainty. Preserve current consent disable/clear semantics.
- Retain the tested requirement-first renderer as the experimental fallback. Enable additional
  bundle/retrieval/output strategies by named candidate configuration until their gates pass.

## 12. File-level work breakdown

Names marked **new** are proposed; final naming should follow surrounding module conventions.

| Area              | Files                                                                                                                         | Intended work                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Storage/runtime   | `src/platform/runtime-paths.ts`; **new** `benchmarks/continuity/runtime.mjs`                                                  | Local roots, read/write probes, space checks, archive manifests                             |
| Benchmark logging | `benchmarks/continuity/bidirectional.mjs`; **new** `benchmarks/continuity/trace-writer.mjs`                                   | Incremental filtered event stream, limits, monotonic timestamps, fault reporting            |
| Budget/recovery   | `benchmarks/continuity/receivers.mjs` and shared session ledger                                                               | One ledger across phases, durable reservation, explicit recovery without duplicate launches |
| Snapshot identity | `src/git/repository.ts`; **new** `src/context/snapshot.ts`                                                                    | Versioned covered-input identity, consistent reads, strong/partial coverage                 |
| Verification      | `src/cli/finish.ts`, `src/state/schema.ts`, `src/context/schema.ts`; **new** `src/context/verification.ts`                    | Receipts, environment qualification, freshness states and backward compatibility            |
| Packet/inspection | `src/context/briefing.ts`, `src/context/render.ts`, `src/handoff.ts`, `src/lifecycle.ts`; **new** `src/context/inspection.ts` | One requirement-first packet and bounded current-state bundle                               |
| Lookup            | `src/cli/context.ts`; **new** `src/context/retrieval.ts`                                                                      | Windows, cursors, file/command filters, batches, explicit full lookup                       |
| Launch freshness  | `src/cli/switch.ts`, `src/application/sessions.ts`                                                                            | Include packet/snapshot identities in current launch checks                                 |
| Configuration     | `src/config/schema.ts` and loader tests                                                                                       | Optional versioned strategy/budget fields, conservative legacy defaults                     |
| Analysis          | `benchmarks/continuity/analyze-cross.mjs`, replay tools, reports                                                              | Phase metrics, repeated-work review, validity and paired comparisons                        |
| Tests/docs        | `tests/context/`, relevant Git/session tests, CLI/prototype docs                                                              | Contracts, failure cases, new command documentation and qualification evidence              |

## 13. Implementation order and reviewable milestones

| Milestone                           | Depends on                   | Deliverable                                                   | Exit condition                                                           |
| ----------------------------------- | ---------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------ |
| M0: baseline/telemetry              | Existing retest artifacts    | Frozen control and metric definitions                         | Counters and historical scores replay unchanged                          |
| M1: reliable harness                | M0                           | Local roots and bounded append logging                        | Fault-injection tests pass; no live-call prerequisite                    |
| M2: snapshot/receipts               | M1                           | Covered code identity and freshness display                   | Stale/unknown tests cannot be called reusable                            |
| M3: inspection packet               | M2                           | Requirement-first current-state bundle                        | Saved cases preserve instructions; bounded preparation and output        |
| M4: targeted retrieval              | M3                           | Windows/find/batch operations                                 | Exact source parity and lower fixture retrieval volume                   |
| M5: output/layout preparation       | M1–M4                        | Named profiles, balanced protocol, saved-observation analysis | Offline preservation/counter tests pass; live benefit remains unmeasured |
| E1: controlled live smoke           | M1–M4 and separate budget    | Fresh paired receiver observations                            | No correctness regression; trace diagnosis complete                      |
| E2: layout/output ablation          | E1 and separate budget       | Separately measured policy candidate                          | No quality loss; measured net usage/time benefit                         |
| E3: held-out validation/integration | Winning candidate and budget | Broader paired results and native switch acceptance           | Promotion targets met per provider or candidate remains experimental     |

The earlier table labeled the live stages M5–M7. E1–E3 now consistently name those evaluation
gates, matching Section 15. M5 here identifies Phase 5's implementation/offline preparation and
does not satisfy a live exit condition or authorize additional sessions. Phase 6 integration
remains gated on the winning-candidate evidence described above.

The smallest useful first delivery is M0–M1. The first behavior-changing candidate is M2–M4,
with verification freshness display but without automatic test skipping. Finish each milestone
with a focused diff, appropriate checks, and a written decision before adding the next variable.

## 14. Offline test plan

### Preserve the existing regressions

- All six interrupted-history fixtures and the saved requirement-preservation cases.
- Complete long submissions, contradictory later corrections, overflow source instructions,
  paginated task lookup, historical path guidance, and source/compiled fake-provider switches.

### Add tests tied to the new failure modes

| Area         | Meaningful cases                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Logger       | Many small chunks; split Unicode; partial JSON; duplicate events; bounded backpressure; disk-full and fsync failure; exit during flush           |
| Runtime      | Canonical path aliases; unreadable/cloud-placeholder inputs; separate workspace/log volumes; interrupted archival; recovery ledger conservation  |
| Snapshot     | Same-name untracked edits; staged/unstaged cancellation; rename/mode change; symlink/submodule; external edits mid-inspection; oversized input   |
| Verification | Matching deterministic receipt; runtime/config change; unknown environment; nonzero/null exit; interrupted command; assistant-only success claim |
| Inspection   | Complete requirements plus noisy output; minimal repository control; multiple relevant files; huge diff; binary changes; no evidenced next step  |
| Retrieval    | Missing/cross-task IDs; stale cursors; changed filters; line and character boundaries; maximum-size envelopes; partial batch failures            |
| Analysis     | Usage/turn deduplication; null metrics; disk-failed acceptance pass; pairwise exclusion; setup and receiver costs separated                      |

Use fake providers for process contracts. Live model calls are not needed for these tests.
Measure local preparation and returned bytes on declared repository-size fixtures; do not write
tests that simply repeat implementation arithmetic without asserting an external contract.

Run appropriate typecheck, lint, formatting, build, affected tests, fixture validation, and
package/packed CLI checks when runtime changes reach the bundle. Use the clean verification
checkout when the main workspace has unrelated sync duplicates or unreliable file reads.

## 15. Live evaluation design and proposed budgets

All previous live budgets, including E1's newly approved eight receivers, are exhausted.
E1 below is now a completed run with the linked qualification limits. E2/E3 remain **proposals
requiring separate authorization**. Offline preparation and replay do not consume provider sessions.

### Evaluation stages

| Stage                     | Design                                                     | Receivers | New predecessors | Stage launch allowance | Purpose                                                                                  |
| ------------------------- | ---------------------------------------------------------- | --------: | ---------------: | ---------------------: | ---------------------------------------------------------------------------------------- |
| E0: offline qualification | Fixtures, saved traces, simulated faults                   |         0 |                0 |                      0 | Correctness of capture/render/retrieval/harness                                          |
| E1: smoke                 | 4 saved checkpoints × 2 arms × 1 trial                     |         8 |                0 |                      8 | Frozen requirement-first control versus M2–M4 candidate                                  |
| E2: ablation              | 4 saved checkpoints × 3 variants × 1 trial                 |        12 |                0 |                     12 | Frozen control, bundle-only, bundle + targeted retrieval; choose one variable to isolate |
| E3: held-out validation   | 4 new task designs × 2 directions × 3 arms × 2 repetitions |        48 |                8 |                     56 | Requirement-first control, full history, selected candidate                              |

E1 used eight launches. Approving the remaining E2/E3 proposals would add 68, for **76 launches**
in this evaluation sequence, including eight new predecessors. Each later stage requires its own
decision and budget; a negative gate can end the sequence. Cache/output tuning can replace the E2 variants after an agreed protocol amendment,
or receive its own later budget; it is not an uncounted extra experiment.

Use the same eight held-out checkpoints across E3 receiver repetitions. Repetitions estimate
run variability; they do not turn four independent task designs per direction into eight
independent tasks. Extend the sample before broad significance or reliability claims.

### Task design

Keep the existing ledger/feed checkpoints as development controls. Add held-out tasks that
exercise different transfer needs:

1. A repository-sufficient control where little extra history should be necessary.
2. A multi-file API change with a later user correction unavailable from the initial brief.
3. A rejected approach plus a failed check followed by an unverified partial edit.
4. A mixed test state with deterministic checks, one environment-dependent check, and a
   requirement to preserve an existing behavior that is easy to overlook.

Vary source-history size, require meaningful multi-file continuation, and freeze acceptance
drivers before any receiver runs. Correctness grading should include constraint violations,
not just public tests. Grade unnecessary clarification, repeated rejected approaches, and
unsupported verification claims through reviewed visible traces after runs complete.

### Execution controls

- Pin exact candidate/control source, bundle, fixture, code, and history hashes.
- Record CLI versions and requested/resolved models where available. Freeze model, effort,
  permissions, common workspace instructions, and tool surface within each paired comparison.
- Rotate/randomize order using a saved seed and balance it across direction/task/repetition.
- Keep private artifacts outside receiver-readable roots as far as the actual sandbox permits;
  use a read policy that prevents access to other solutions. Document residual shell-read access
  rather than calling prompt instructions isolation. Do not weaken provider sandboxes to run tests.
- Both representation arms can retrieve the same authorized source material. Measure any
  candidate-specific retrieval interface as part of the candidate treatment and state that clearly.
- Proposed starting limits: 180 seconds per receiver; for E3, up to 180 seconds per predecessor,
  with a predeclared interruption boundary after meaningful partial work. Choose task-specific
  boundaries and any timeout changes before running, never increase only a failing treatment's limit.
- A launch cap is not an API-request, model-turn, dollar, or subscription-quota cap. Include
  every predecessor, receiver, resume/replacement process, and model-assisted preparation call
  in the authorized accounting. If a multi-turn predecessor requires additional CLI launches,
  amend E3's eight-predecessor allowance before execution rather than hiding them as setup.
- Preflight failures occur before a launch reservation when no provider is started. Once a
  provider starts, the attempt counts, including authentication errors and zero-token failures.
- Stop on infrastructure or provider-wide failures, preserve the ledger, and require an explicit
  recovery decision. Continuing unattempted sessions never resets the total cap.

### Reporting

Publish per-direction, per-task, and aggregate matched results with:

- All-attempt acceptance and strict success, plus separately labeled infrastructure incidents.
- Clean matched-pair performance excluding both sides of an affected pair; keep raw totals too.
- Median paired deltas, per-case deltas, spread, sample size, and any descriptive intervals.
- Preparation, capture, retrieval, receiver, and archival components; unknowns remain null.
- Cache creation/read counters, output tokens, model/tool turns, and retrieval volume.
- Code/requirement regressions, unnecessary repair, and unsupported claims.

Do not select the fastest retry, erase an incident, or substitute new metrics into historical
reports. A smaller prompt alone cannot satisfy a promotion gate.

## 16. Completion checklist

- [x] Freeze the current requirement-first control and baseline metrics.
- [x] Implement storage preflight, canonical local benchmark roots, and incremental logging.
- [x] Add covered snapshot identity and verification freshness receipts.
- [x] Build the bounded current-state inspection packet without losing required text.
- [x] Add exact evidence/file windows and bounded batched retrieval.
- [x] Pass offline fault, Unicode, freshness, pagination, and source/compiled process tests.
- [x] Prepare isolated output/layout profiles, budget-preserving fallback, and balanced cache-analysis controls.
- [x] Review and obtain a budget for E1; execute once and report all attempts (2026-11-18; helper-routing limits documented).
- [ ] Isolate promising changes through E2 before combining additional policies.
- [ ] Freeze held-out E3 tasks and obtain its budget separately.
- [ ] Qualify native application switches and platform behavior for any promoted candidate.
- [ ] Update CLI/config/prototype docs to describe implemented behavior and remaining limits.
- [ ] Promote only a candidate that meets the per-provider correctness and efficiency gates.

## References

- [Current continuity prototype and evidence contract](continuity-prototype.md)
- [Original real two-way pilot](../benchmarks/continuity/reports/2026-11-02-bidirectional.md)
- [Requirement-preservation offline replay](../benchmarks/continuity/reports/requirement-preservation-replay.md)
- [Fresh receiver retest and storage incident](../benchmarks/continuity/reports/requirement-first-live-retest.md)
- [Benchmark commands and retained result conventions](../benchmarks/continuity/README.md)
- [Existing checkpoint/handoff behavior](checkpoints-and-handoff.md)

This plan addresses the current automatic-continuity prototype. Earlier plans and archived
benchmarks retain their historical scope and results.
