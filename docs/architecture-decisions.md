# Architecture decision record

Audit started **2026-11-11**. Scope: the maintained CLI, TUI, Electron runtime, experimental
continuity in the alpha.5.5 CLI, and repository benchmark tooling.

These are **retrospective decision records**, not invented historical approvals. “Rationale”
states the engineering reason supported by the implementation and existing plans; original
author intent is unknown where it was not recorded. “Implemented” does not imply acceptance on
every provider/platform. Experimental and inactive designs are identified explicitly.

Read the [system overview](architecture.md), [runtime mechanics](runtime-protocols.md),
[continuity pipeline](continuity-architecture.md), and [audit ledger](architecture-audit.md)
alongside these records.

## Decision index

| IDs         | Area                                                                                            |
| ----------- | ----------------------------------------------------------------------------------------------- |
| ADR-001–003 | Product boundary, shared application services, provider capabilities                            |
| ADR-004–008 | State publication, locking, idempotency, ownership, recovery                                    |
| ADR-009–014 | Detached terminals, IPC/control, bounded output, native PTYs, lifecycle, projections            |
| ADR-015–018 | Coordination, resume/attach, Git workspaces, checkpoints                                        |
| ADR-019–024 | Usage, distribution, frontend material/state, inactive approvals, compatibility                 |
| ADR-025–036 | Consent, evidence, requirements, authority, snapshots, receipts, inspection/retrieval, policies |
| ADR-037–042 | Frozen controls, benchmark runtime/ledgers/traces, evaluation, documentation evidence           |

## ADR-001: Local control plane

**Status:** implemented. **Rationale:** product boundary recorded in the README and security docs.

The installed provider CLI performs inference and owns its account/conversations. Rirei starts
that CLI, maintains independent task records, and presents a bounded continuation prompt. This
supports separately authenticated tools without copying account credentials or introducing a
Rirei model-service dependency. It does not pool quotas or transfer a live provider conversation.

**Mechanism:** explicit executable/argument arrays through `AgentAdapter` and `SessionManager`.
**Tradeoff:** behavior/model availability depends on installed CLI versions; a fresh launch can
cost more than continuing the current provider. **Evidence:** `src/agents/adapter.ts`,
`src/application/sessions.ts`, `tests/agents/registry.test.ts`.

## ADR-002: Shared command engine and separate process hosts

**Status:** implemented. **Rationale:** reconstructed from the shared application boundary.

CLI, Ink, and Electron should apply the same task/lease rules. Commander commands call shared
services, while the daemon runs the same CLI inside a PTY. `SessionManager` depends on
`ProcessHost`, not Electron; deterministic fake hosts exercise launch/finalization contracts.
`TerminalHost` separately supplies PTY mechanics.

**Tradeoff:** the CLI's inherited host cannot implement a renderer's raw stdin/resize semantics;
native PTY hosting remains a separate layer. There are TypeScript and ESM host implementations
to keep aligned. **Evidence:** `src/process/process-host.ts`, `src/process/inherited-process-host.ts`,
`src/terminal/terminal-host.ts`, `desktop/terminal-host.mjs`, `tests/application/sessions.test.ts`.

## ADR-003: Capability-driven provider adapters

**Status:** implemented. **Rationale:** documented adapter extension contract.

Provider flags, model/effort discovery, authentication views, resume support, usage collection,
and exit classification belong behind an adapter. Callers inspect capabilities rather than
assuming every provider supports Claude-like hooks or resume/effort syntax. OpenCode has a
bespoke adapter because its multi-provider identifiers and auth/resume semantics differ.

**Mechanism:** bounded official CLI probes; unavailable/unsupported/error discovery is explicit.
Authentication “configured” is weaker than “authenticated.” **Tradeoff:** provider catalogs and
schemas drift and need fixture/native version qualification. **Evidence:** `src/agents/registry.ts`,
`src/agents/adapter.ts`, `tests/agents/auth.test.ts`, `tests/agents/opencode.test.ts`.

## ADR-004: Validated JSON task snapshots

**Status:** implemented. **Rationale:** reconstructed portability and inspectability tradeoff.

Task state is one Zod-validated JSON snapshot, not a remote database or event-replay requirement.
`updateState` locks, re-reads, applies an optional revision/operation guard, increments revision,
and publishes a unique temporary file by rename. Closed-task replacement archives metadata first.
Reads migrate in memory; the first upgraded write backs up the original state.

**Tradeoff:** full-file serialization and local locks limit write throughput. State publication,
archive creation, checkpoint files, and activity are not one atomic transaction. `writeState`
alone does not lock or increment revisions, and its rename writer does not explicitly fsync.
**Evidence:** `src/state/store.ts`, `src/state/migrations.ts`, `tests/state/concurrency.test.ts`.

## ADR-005: Owned writer locks with an acquisition gate

**Status:** implemented for authoritative state and named directory locks.

Several controllers must not overwrite one another. A writer builds a private claim directory
containing host/PID/random-token metadata, then renames it into the named lock. A second gate
serializes acquire, reclaim, and release so a stale owner cannot delete a newer owner's lock.
Ownership tokens are rechecked on removal. A same-host dead PID permits reclamation; age alone
does not. Unknown owners fail closed after bounded contention.

**Tradeoff:** a slow/live writer can block work, and short gate waits can fail under host load.
Not every derivative journal uses this algorithm; terminal-journal lock reclamation is age-based.
**Evidence:** `src/state/lock.ts`, `tests/state/concurrency.test.ts`, M5's recorded parallel failures.

## ADR-006: Stable launch identity beyond a bounded operation ledger

**Status:** implemented. **Rationale:** prevent duplicate paid/provider processes after retries.

A run ID derives from task session plus launch operation ID. Before acquiring a lease, the
locked state is checked for that run in durable history. This remains useful after old generic
operation-ledger entries rotate. A completed retry returns its stored outcome; an uncertain
active retry refuses to spawn a second process.

**Tradeoff:** idempotency requires callers to reuse the same operation ID. It cannot make
arbitrary external side effects transactional or prove an unrecorded provider never started.
**Evidence:** `src/application/sessions.ts`, `tests/application/sessions.test.ts`,
`tests/cli/lifecycle.test.ts`.

## ADR-007: Cooperative writing leases per worktree

**Status:** implemented. **Rationale:** isolate managed concurrent edits without a central scheduler.

`runs` is the authoritative lease collection. Acquiring a run checks that another managed run
does not already claim the same worktree; several runs can exist when their worktrees differ.
`currentAgent`/`currentRunId` remain compatibility mirrors. Daemon admission separately reserves
startup claims before asynchronous PTY creation.

**Tradeoff:** leases do not prevent edits by a shell, editor, unmanaged process, or malicious
same-user program. Workspace roles are workflow labels, not OS permissions. **Evidence:**
`src/state/leases.ts`, `desktop/terminal-daemon-server.mjs`, `tests/worktrees/manager.test.ts`.

## ADR-008: Evidence-based recovery instead of heartbeat-age release

**Status:** implemented. **Rationale:** avoid releasing a worktree while a provider may still write.

Controllers carry a fresh instance identity, PID, and a host/approximate-boot marker. Heartbeats
refresh owned leases; stale time alone does not establish death. Reconciliation treats a complete
daemon inventory differently from a missing/partial view. A present terminal can be adopted by
that daemon. A missing terminal can be finalized after same-host prior-boot evidence or the
required controller/bridge death checks; ambiguous ownership stays orphaned/blocked.

**Tradeoff:** conservative false negatives require operator recovery. PID/boot checks are local
evidence, not cryptographic process attestation. Forced recovery records interruption without
proving the provider stopped. **Evidence:** `src/application/controller.ts`, `heartbeat.ts`,
`reconciliation.ts`, `tests/application/reconciliation.test.ts`.

## ADR-009: Detached daemon owns interactive PTYs

**Status:** implemented. **Rationale:** renderer/window restart should not destroy a coding session.

Live PTYs, runtime/lifecycle state, attachment/control relationships, and the bounded output
ring belong to the daemon. Electron and the TUI reconnect to it. The child relay controller
continues to own provider task semantics. Ordinary shell tabs do not need Relay task state.

**Tradeoff:** daemon discovery, protocol compatibility, and orphan reconciliation become necessary.
The output ring is memory, not a persisted transcript; daemon death is not session restoration.
**Evidence:** `desktop/terminal-daemon-server.mjs`, `src/platform/daemon-manager.ts`,
`tests/desktop/terminal-daemon.test.ts`.

## ADR-010: Distinct local capabilities and explicit terminal control

**Status:** implemented. **Rationale:** keep read attachment, input ownership, and status reporting distinct.

The private daemon descriptor carries a reconnect capability. A lifecycle hook instead gets a
terminal-scoped token restricted to normalized state reports. An attached observer must acquire
connection control before write/resize. Explicit takeover notifies and revokes the old controller.
These tokens are not provider account credentials and do not authorize provider tool approvals.

**Tradeoff:** descriptor possession is same-user local authority, not isolation from hostile
same-user processes. Other authenticated operations have their own checks; write control is
not a universal authorization model for every daemon operation. **Evidence:**
`desktop/terminal-daemon-server.mjs`, `terminal-daemon-client.mjs`, `tests/desktop/terminal-daemon.test.ts`.

## ADR-011: Bounded pull-based terminal output

**Status:** implemented. **Rationale:** slow/reconnecting views should not accumulate unlimited output.

Output is a 2 MiB byte ring with absolute cursors. Availability events contain metadata; clients
pull base64 slices capped at 64 KiB. Old cursors disclose truncation. Electron delivers one
in-flight slice per renderer/terminal and waits for the matching acknowledgement before advancing;
final exit is delayed until pending output is handled.

**Tradeoff:** old output can be lost after ring eviction. Renderer acknowledgement is not durable
transcript storage or proof that the model consumed output. TUI passthrough has a different
stdout-delivery path. **Evidence:** `desktop/main.mjs`, `desktop/terminal-daemon-server.mjs`,
`src/tui/attach.ts`, `tests/cli/attach.test.ts`.

## ADR-012: Native node-pty and explicit compatibility bridge

**Status:** implemented; native acceptance still platform-specific.

Provider TUIs require a real terminal emulator and PTY. Current factories use `node-pty`, with
ConPTY on Windows. POSIX parent guarding and bounded tree-stop escalation help terminate
descendants without losing the controller's finalization opportunity. Natural Windows exit
explicitly closes native ConPTY resources so output workers do not retain the process.

The Python helper remains an explicitly forced compatibility/test path; it is not an automatic
fallback when native loading fails. Native packages and external helpers complicate packaging.
**Evidence:** `desktop/terminal-host.mjs`, `desktop/node-pty-loader.cjs`,
`src/terminal/terminal-host.ts`, `tests/terminal/terminal-host.test.ts`.

## ADR-013: Passive lifecycle signals and conservative exit classification

**Status:** implemented. **Rationale:** a wait indicator is not permission-decision authority.

Claude hooks, a capability-authenticated Codex loopback supervisor, and OpenCode's authenticated
loopback SSE/REST observer report only working/permission/input-wait states. Unsupported providers
use conservative terminal attention hints. The daemon advances active runtime only during
starting/working, and sequences observations so delayed waits cannot revive a stopping terminal.

Exit classification keeps reason/confidence/source. Fresh quota evidence can qualify a nonzero
exit at medium confidence; a bare error string or zero exit is not reinterpreted as exhaustion.
**Tradeoff:** status-only integration is not native continuity capture or tool approval.
**Evidence:** provider lifecycle wrappers, `src/agents/limit-detection.ts`, wrapper/limit fixture tests.

## ADR-014: Derived public activity and private restart hints

**Status:** implemented. **Rationale:** companion UIs need bounded status, not private task contents.

Activity v3 is rebuilt from validated state into sanitized fixed-vocabulary session records;
publication failure cannot roll back task state. `appendEvent` is a compatibility projection
hook, not an append-only event database. Private project-keyed terminal journals retain bounded
restart-discovery metadata, including project paths, separately from the public feed.

**Tradeoff:** projections can lag or disappear. Terminal journals use different durability/lock
rules and do not establish process liveness. **Evidence:** `src/state/activity.ts`, `events.ts`,
`journal.ts`, `desktop/terminal-journal.mjs`, `tests/state/activity.test.ts`.

## ADR-015: Durable manual inbox coordination

**Status:** implemented; automatic delivery modes reserved.

Threads route by canonical task/run/operator identities, never non-unique display labels.
The service holds a task-lifecycle state guard before the Threads journal lock; this orders a
send against task closure and run finalization. Strict bounded envelopes, recognized-secret
handling, and operation/payload identity protect journal consistency. Context capture times
are nonsemantic for retry identity.

Queued/read/acknowledged do not mean injected into provider context. `wake`/`next_safe_turn`
remain unsupported; notifications carry IDs/revision only, not bodies. **Tradeoff:** a provider
must explicitly read its inbox. **Evidence:** `src/messages/`, `docs/relay-threads.md`,
`tests/messages/service.test.ts`.

## ADR-016: Provider resume and terminal reattach are different

**Status:** implemented. **Rationale:** the provider owns conversation persistence, the daemon owns a live PTY.

Resume/fork builds provider-specific arguments and starts a new process/PTY. Only exposed or
explicitly selected provider session IDs are recorded. `attach` instead reconnects to an
existing daemon terminal, optionally read-only or with explicit takeover. Detach restores terminal
mode and leaves the live session running.

**Tradeoff:** missing provider IDs cannot be reconstructed by scanning conversations, and daemon
death cannot be repaired by merely replaying an output cursor. **Evidence:**
`src/cli/resume.ts`, `src/tui/attach.ts`, adapter resume builders, `tests/cli/lifecycle.test.ts`.

## ADR-017: Previewed additive workspaces and manual cleanup

**Status:** implemented. **Rationale:** isolate edits while keeping Git integration user-owned.

Workspace preview fixes repository identity, base commit, generated branch/path, task, and role.
Execution revalidates under the repository lock, rejects conflicting paths/branches, runs
`git worktree add -b`, then writes the registry. Idempotent workspace operation IDs can reuse an
existing matching registration. Cleanup inspects dirtiness, divergence/upstream, and run ownership.

**Tradeoff:** Git creation plus JSON registration is not one transaction. Partial creation is
reported and not automatically deleted because it may hold work. Cleanup prints commands rather
than running removal/merge. **Evidence:** `src/worktrees/manager.ts`, `registry.ts`,
`tests/worktrees/manager.test.ts`.

## ADR-018: Bounded checkpoints are inspection artifacts

**Status:** implemented. **Rationale:** retain useful Git context without committing or copying an entire workspace.

A checkpoint contains metadata, porcelain status, diff statistics, and a bounded tracked patch.
References are published after artifact writes. Readers validate artifact IDs, metadata/path
relationships, file types and display bounds. Old current-task checkpoints are pruned by configured
count; archived tasks retain their referenced artifacts.

**Tradeoff:** untracked file contents are not backed up, the patch may be truncated/unredacted,
and there is no automatic rollback or full state reconstruction. A matching legacy Git fingerprint
is not a test receipt. **Evidence:** `src/lifecycle.ts`, `src/checkpoints.ts`, `tests/checkpoints.test.ts`.

## ADR-019: Separate quota telemetry from token analytics

**Status:** implemented. **Rationale:** percentages, token counts, and subscription cost are different measurements.

Provider quota samples can support freshness-qualified warnings and handoff offers. Independent
opt-in analytics runs the pinned install-owned `ccusage` binary with offline/no-cost flags,
closed stdin, neutral cwd, bounded output/time, and an empty config override. Rirei normalizes
and privacy-validates numeric reports; it does not intentionally retain raw conversations.

The timezone-bound 180-day cache supports range derivation, per-agent refresh locks, short
single-flight reuse, and last-good snapshot retention. Cache-only reads do not launch scans.
**Tradeoff:** the external scanner has access to provider logs; flags are not an OS sandbox.
Missing session/counter coverage stays unknown. **Evidence:** `src/token-usage/`,
`src/agents/usage-collectors.ts`, `tests/token-usage/cache.test.ts`.

## ADR-020: Distinct CLI and desktop distribution artifacts

**Status:** implemented release mechanism; publication/signing state remains separate.

esbuild emits one CLI entry but deliberately externalizes native/ESM runtime dependencies.
npm uses a narrow package allowlist; Electron includes more runtime files and unpacks the daemon
closure so Node/native helpers can execute outside ASAR. Vendored xterm assets avoid a runtime
CDN. Release validation installs the same once-packed tarball across the OS/Node matrix.

**Tradeoff:** source success does not prove packed native loading. npm trusted publication and
macOS signing/notarization require owner/release setup. **Evidence:** `scripts/build.mjs`,
`scripts/check-package.mjs`, `.github/workflows/release.yml`, `scripts/smoke-packed-install.mjs`.

## ADR-021: Native material with explicit readability tradeoffs

**Status:** implemented. **Rationale:** documented desktop material design.

macOS uses OS vibrancy with graduated translucent CSS scrims and transparent xterm surfaces;
other platforms use opaque window material. Dialogs remain high-contrast and reduced-transparency
preferences restore an opaque palette. This keeps native material consistent across chrome and
terminal instead of stacking independent blur layers.

**Tradeoff:** transparent terminal rendering gives up xterm's opaque fast path. These are design
tokens with performance/accessibility consequences, not a claim of cross-platform visual identity.
**Evidence:** `desktop/main.mjs`, `desktop/renderer/styles.css`, `docs/desktop.md#window-material`.

## ADR-022: Validated frontend bridges and ephemeral UI state

**Status:** implemented. **Rationale:** rendering should not be a second task database or generic Node executor.

Electron uses isolated/sandboxed rendering, a named preload bridge, validated requests, and
webContents/terminal ownership checks. Navigation/window opening and deep links are constrained.
Latest-request tickets reject stale asynchronous view responses. Local preferences store provider
model/effort choices; durable run outcomes come from CLI state/daemon inventory.

**Tradeoff:** model/effort session profiles are distinct from M5 handoff profiles. UI preferences
can be stale and are not run authority. **Evidence:** `desktop/preload.cjs`, `desktop/main.mjs`,
`desktop/renderer/latest-request.mjs`, `tests/desktop/latest-request.test.ts`.

## ADR-023: External permission decisions remain inactive

**Status:** specified/inactive transport; validated protocol/store code exists.

Future permission decisions need a terminal/run-owned, expiring, one-shot channel with only
allow-once/deny, transient request details, and fail-closed replay handling. A passive wait
observer cannot safely be upgraded into approval by scraping terminal output or typing keys.

**Tradeoff:** current users approve in the provider's native UI. The presence of
`desktop/approval-protocol.mjs` and tests does not activate a listener or authorize provider
permission replies. **Evidence:** `docs/approval-protocol.md`, `tests/desktop/approval-protocol.test.ts`.

## ADR-024: Independent version and storage namespaces

**Status:** implemented facts, with documented compatibility debt.

Persistent task state, activity, daemon framing, journals, snapshots, receipts, retrieval, and
policy metadata version independently. An additive optional field need not reinterpret an old
artifact as stronger evidence. Likewise task-local storage, platform application support,
Electron userData, legacy worktree storage, and legacy quota storage have distinct owners.

**Tradeoff:** resolver/wire implementations are duplicated and not fully unified. Relative override
semantics and some Windows desktop paths differ; documentation must name the actual consumer
rather than promise a completed migration. **Evidence:** `src/platform/runtime-paths.ts`,
`src/worktrees/data-dir.ts`, `desktop/main.mjs`, `src/state/migrations.ts`.

## ADR-025: Separate per-task capture consent

**Status:** opt-in CLI experiment. **Rationale:** recorded continuity/privacy contract.

Visible work capture is independent of machine-wide token analytics. Only the operator changes
task consent or clears generated context through the CLI. Each toggle changes a policy epoch,
invalidating old capture grants. A new managed Claude launch receives session-local settings and
a scoped grant; inherited capture markers are removed before the new grant environment is applied.

**Tradeoff:** existing sessions/transcript directories are not backfilled. Disable retains data
but excludes automatic disclosure; clear removes generated capture artifacts, not task receipts.
**Evidence:** `src/context/capture.ts`, `store.ts`, `src/cli/context.ts`, capture/CLI tests.

## ADR-026: Bounded hash-linked visible evidence

**Status:** opt-in CLI experiment. **Rationale:** preserve interruption evidence without inventing missing events.

Allowlisted normalizers separate submissions, tool starts/results, assistant claims, session events,
and gaps. Strict storage validation checks task, sequence, unique IDs, previous hash, and record
hash. A locked, fsynced temporary-file replacement publishes the logical append. Stable source IDs
deduplicate replay; intentional repeated submissions remain distinct.

**Tradeoff:** rewriting a bounded journal is not an unlimited log. An unterminated tail is disclosed
and ignored on read; append stops rather than overwriting it. Hashes detect inconsistency, not
authorship against a same-user rewrite. **Evidence:** `src/context/schema.ts`, `store.ts`, `claude.ts`,
`codex.ts`, `tests/context/capture.test.ts`.

## ADR-027: Exact requirements before optional evidence

**Status:** opt-in CLI experiment. **Rationale:** recorded response to observed live requirement loss.

Whole retained submissions are selected before tool output. If all fit, they remain chronological;
otherwise newer whole messages take priority and exact excerpts are fallback previews only.
Coverage metadata distinguishes fully inline, lookup-required, and already truncated/redacted
sources. Any unshown submission produces required paged task retrieval before editing.

**Tradeoff:** even a longer sufficient prompt may cost more initially. No model infers requirements,
semantic supersession, or a missing next step. **Evidence:** `src/context/briefing.ts`,
`tests/context/briefing.test.ts`, requirement-first replay/live-retest reports.

## ADR-028: Historical paths are not workspace authority

**Status:** opt-in CLI experiment. **Rationale:** recorded stale-workspace failures in the two-way pilot.

The current canonical workspace is stated separately. Path-bearing historical tool/assistant
previews can be omitted with citations while retained sources remain exact. Direct code selection
uses validated relative fields, not shell-string dependency inference. Explicit submitted wording
is preserved even when it mentions a path.

**Tradeoff:** display heuristics are not a sandbox or complete path detector. Historical records
can still contain old paths; lookup does not authorize following them. **Evidence:**
`src/context/paths.ts`, `briefing.ts`, `inspection.ts`, historical-path regression tests.

## ADR-029: Separate covered-input identity

**Status:** implemented in M2. **Rationale:** legacy Git status/combined diff misses important input changes.

The new algorithm binds canonical workspace/common Git identity, HEAD/branch, exact index/tree
entries, modes, and actual tracked/nonignored untracked bytes. Two consecutive scans must agree,
with one additional scan available after a changed boundary. Metadata-only file caches cannot
claim unchanged content. Scope/omission limits qualify the identity explicitly.

**Tradeoff:** this is bounded observation, not hermetic/environment equivalence. Ignored/generated,
sensitive, linked/submodule, unstable, oversized, or unavailable input remains unqualified.
**Evidence:** `src/context/snapshot.ts`, `snapshot-schema.ts`, `tests/context/snapshot.test.ts`.

## ADR-030: Pending-before-command verification receipts

**Status:** implemented in M2. **Rationale:** a run-start anchor or assistant success claim cannot verify current code.

Configured tests persist a pending receipt before spawn and record observed exit, monotonic
duration, start/end snapshots, and a conservative environment identity. The command is redacted
before hashing, output is explicitly not captured, and interrupted/missing exits remain unknown.
Optional schema-v8 receipts preserve old readers' unknown-coverage interpretation.

**Tradeoff:** file boundary equality cannot rule out transient edits or uncontrolled services,
dependencies, clock/randomness, tool versions, or environment. No CLI creates the trusted scope
required for reuse eligibility; tests are never auto-skipped. **Evidence:** verification modules,
`src/cli/finish.ts`, `tests/context/verification.test.ts`, `tests/cli/finish-verification.test.ts`.

## ADR-031: One bounded inspection response from one observed snapshot

**Status:** implemented in M3. **Rationale:** reduce broad rediscovery without trading away required instructions.

Inspection combines whole requirements, file states, verification, recorded actions, and optional
code. Current bytes come from the stable scan; historical blobs come from immutable Git object IDs.
Changed hunks rank before directly cited files. Repeated references do not duplicate windows.
Large/incomplete inputs get explicit omissions/metadata rather than misleading complete code.

**Tradeoff:** display diffs are bounded/redacted excerpts, not applyable complete patches. An
eight-entry derived cache still requires live input/state/history qualification. **Evidence:**
inspection modules, `tests/context/inspection.test.ts`, `benchmarks/continuity/inspect.mjs`.

## ADR-032: Exact historical and current-file windows are different result types

**Status:** implemented in M4. **Rationale:** avoid confusing reported output with current source code.

Evidence windows reference immutable retained text and record/text digests. File windows require
a matching complete snapshot or explicitly file-scoped content hash, retain exact UTF-8/BOM/CRLF,
and report actual line/UTF-16 coordinates. Recognized-secret file contents are withheld rather
than silently rewritten. Find intersects exact reported fields through a journal-bound index.

**Tradeoff:** large/unknown sources can fail, and a preview is not a full source. Legacy full
evidence remains explicit. **Evidence:** `src/context/retrieval*.ts`, retrieval window/CLI tests.

## ADR-033: Source-bound cursors and fair bounded batches

**Status:** implemented in M4. **Rationale:** pagination must not silently shift across changed inputs.

Cursors bind task/workspace, consent/history, source identity, and semantic filters/ranges.
Actual positions adjust surrogate boundaries; long file lines continue by column. A batch has
at most eight queries and returns every query's ok/error/deferred/done state, rotating progress
under the final envelope cap. Changing a source/query invalidates continuation.

**Tradeoff:** cursor checksums are not authentication and do not bypass normal source checks.
Callers must repeat semantic arguments and inspect per-item errors. **Evidence:**
`retrieval-cursor.ts`, `retrieval.ts`, `tests/context/retrieval-batch.test.ts`.

## ADR-034: Layered budgets with declared units

**Status:** implemented in baseline and experimental continuity.

Legacy capsule, evidence postlude, inspection, single-window retrieval, batch, capture storage,
and trace logging have separate ceilings. Final serialized retrieval envelopes include escaping,
labels, cursors, and newline. Source bytes/UTF-16 units/provider tokens are not interchangeable.
Policy overhead consumes capsule headroom, never silently expands evidence or lower user ceilings.

**Tradeoff:** character/4 is an estimate and can differ by provider/language. Mandatory overflow
needs explicit retrieval/clarification rather than a claim of completeness. **Evidence:**
`src/handoff.ts`, context schema/inspection/retrieval/output-policy modules and budget regressions.

## ADR-035: Output/layout profiles remain experiments

**Status:** M5 preview-only experiment; live benefit unmeasured.

Rendering-only profiles isolate focused-output instructions, stable metadata layout, and their
explicit combination. Selected control evidence is unchanged; insufficient budget/unsupported
layout falls back explicitly. Canonical workspace remains early. Static-prefix hashes describe
actual bytes but never become cache-hit counters or a reason to suppress uncertainty.

**Tradeoff:** policy text adds input. A larger shared prefix does not establish provider cache reuse,
lower output, or faster completion. **Evidence:** `src/context/prompt-policy.ts`,
`src/cli/handoff.ts`, `tests/context/prompt-policy.test.ts`, M5 report.

## ADR-036: Provider lifecycle coverage does not imply continuity coverage

**Status:** deliberate qualification boundary.

Native Codex/OpenCode observers can report waits without capturing a submitted instruction or
tool result. Codex exec JSON has a visible-evidence normalizer in benchmark paths; native managed
continuity launch settings currently target Claude. These integrations have different data and
authority contracts and must not advertise one another's coverage.

**Tradeoff:** general interactive reverse capture and native application switches need separate
version/platform acceptance. **Evidence:** `src/context/capture.ts`, `codex.ts`, passive desktop
wrappers, `docs/continuity-prototype.md`.

## ADR-037: Frozen controls instead of moving historical baselines

**Status:** repository benchmark tooling; historic reports retained.

Exact renderer/bundle, code/history fixtures, launch settings, visible traces, and numeric reports
are hashed and independently copied before a control archive becomes complete. The original
V1 renderer is byte-frozen. The current M5 profile named `control` is the current M2–M4 composition,
not a replacement for the archived requirement-first control.

**Tradeoff:** archived environment coverage may remain unknown, and vanished temporary raw data
cannot be claimed retained. **Evidence:** `benchmarks/continuity/freeze-control.mjs`,
`controls/requirement-first.json`, `baselines/rirei-v1.ts`, historical retention notes.

## ADR-038: Local bounded benchmark runtime and preflight

**Status:** implemented in M0–M1 benchmark tooling. **Rationale:** storage errors invalidated otherwise correct live work.

Owned local benchmark roots, canonical paths, free-space allowance, write/fsync/read/delete
probes, and bounded required-input reads precede launch spending. Timings separate preparation,
child execution, finalization, and grading. Explicit production project locations are not silently
moved into benchmark storage.

**Tradeoff:** a free-space reading/probe cannot guarantee future writes. Slow/cloud-backed input
can fail preflight. **Evidence:** benchmark runtime modules, `tests/context/runtime.test.ts`.

## ADR-039: One durable attempt ledger across recovery

**Status:** implemented in M1 benchmark tooling. **Rationale:** local recovery directories must not reset paid launch accounting.

The benchmark reserves a unique session key durably before spawn. Unresolved/failed attempts
block later starts until an explicit reviewed recovery binds permitted unattempted keys to the
same family, protocol identity, stop record, cap, and original ledger. A copied empty sessions
file cannot create fresh allowance.

**Tradeoff:** infrastructure/authentication/zero-token provider launches still consume attempts;
session count is not a dollar, API-request, or internal model-turn cap. **Evidence:**
`benchmarks/continuity/budget.mjs`, `tests/context/budget-recovery.test.ts`.

## ADR-040: Incremental visible tracing with truthful persistence/usage

**Status:** implemented in M0–M1 benchmark tooling. **Rationale:** repeated full-log rewriting was costly and hid logger failure.

A single writer appends each complete allowlisted/redacted event once with streaming UTF-8,
bounded lines/records/bytes and backpressure. Received/written/durable sequence counts differ.
Logger faults stop that benchmark child and later launches, while production capture retains
its non-destructive gap-reporting contract. Final counters and incremental replay reconcile.

**Tradeoff:** interrupted tails and missing usage remain unknown. Provider-specific input/cache/
creation/output/reasoning fields are not interchangeable; reasoning is not added twice.
**Evidence:** measurement/trace-writer modules, `tests/context/trace-writer.test.ts`.

## ADR-041: Quality-first, separately authorized evaluation

**Status:** E1 correctness smoke completed with helper-routing limits; E2/E3 remain pending.

Correctness, infrastructure validity, clean matched comparisons, and efficiency are reported
separately. Output/layout contrasts use planned AB/BA order within receiver/version and observed
spacing, with no cold-cache claim or cache/credential mutation. Counter availability, fallback,
runtime mismatch, and output/tool/time regressions can disqualify a claimed cache pattern.

**Tradeoff:** exact requirement presence, lower retrieved bytes, or synthetic positive counters
do not establish live model quality/cost benefit. A proposed schedule has zero authorized launches.
**Evidence:** efficiency plan, `policy-experiment.mjs`, M0–M5 milestone reports.

The [2026-11-18 E1 run](../benchmarks/continuity/reports/e1-2026-11-18.md) spent eight approved
receivers, with 4/4 strict cases per version. It retained mixed efficiency and login-shell helper
shadowing as explicit findings. No M5 treatment or efficiency default was promoted.

## ADR-042: Evidence-backed architecture documentation

**Status:** documentation convention established by this audit.

Maintained docs link boundaries to implementation/tests, distinguish shipped/prototype/specified
behavior, and label reconstructed rationale. Documentation describes known implementation debt
instead of treating an attractive intended architecture as already implemented. Generated
architecture/health reports remain historical tool output rather than current approval records.

**Tradeoff:** source/decision/qualification changes require documentation review. A coverage matrix
can enumerate principal contracts but cannot prove every historical private rationale has been
recovered. **Evidence:** [architecture audit](architecture-audit.md) and its source/test map.
