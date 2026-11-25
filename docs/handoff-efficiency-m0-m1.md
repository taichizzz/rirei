# Handoff efficiency: M0–M1 milestone

Status: **M0–M1 complete and offline-qualified; M2 next.**\
Plan: [handoff-efficiency-plan.md](handoff-efficiency-plan.md).

Subsequent progress: [M2 implementation and qualification](handoff-efficiency-m2.md). The
M2-next decision below records the state at completion of this earlier milestone.

## Scope and decision

This milestone establishes a reproducible control and a bounded, observable benchmark runtime.
It supplies the measurement foundation for the next snapshot/verification work. It does not
establish a new token, latency, or model-quality gain; no live model sessions were used here.

The next milestone is **M2: covered snapshot identity and verification freshness**. Automatic
test omission remains a separate later experiment, and additional live runs remain budgeted
evaluation stages in the plan.

## M0: frozen control

The requirement-first retest is pinned by
[`controls/requirement-first.json`](../benchmarks/continuity/controls/requirement-first.json).
An independent copy verified 71 retained artifact files, including:

- The exact tested renderer, benchmark source, and compiled CLI bundle.
- Recorded launch arguments/session-local settings and requested model/CLI versions.
- Four frozen code/history checkpoints and eight private prompt/visible-event/result sets.
- The original report, attempt ledger, acceptance results, and storage-affected validity flag.

The verified control resides in persistent local application storage rather than a temporary
checkout or the active source tree. The report hash is
`1e0bde884fdfb04f879e61d6708c2c189733b7bc458de9de90f4aa9fa2222862`.
Its acceptance results remain Rirei 4/4 and full history 4/4; strict success remains 3/4 and
4/4 respectively. Historical host-environment coverage remains unknown.

To independently create another private control archive without launching providers:

```sh
node --import tsx benchmarks/continuity/freeze-control.mjs --source <retained-private-run>
```

The default uses persistent local benchmark storage. `--output <new-directory>` selects
another destination. Every copied file is hash-checked after writing; a complete manifest is
published only after all checks pass. Offline archival permits up to 30 seconds per source
read to materialize retained files. Launch-time input reads use the shorter three-second
deadline. A failed archival attempt remains incomplete and is not a usable control.

## M0: timing and measurement

Each retained visible event now has `_rirei` receipt metadata with a schema version, sequence,
UTC receipt timestamp, and host-monotonic elapsed offset. Execution metadata separately records:

- Preflight and launch-preparation time.
- Provider process exit time and artifact-finalization time.
- Total observed continuation-run time.
- First visible event, first requested tool/edit, and per-tool receipt spans.
- Tool input/output digests, reported file references, retained output bytes, and observed exits.
- Trace write/sync duration and grading start/duration.

Receipt spans include transport/buffering effects; they are not native CPU profiles or direct
measurements of model thinking. Write duration includes periodic sync work, so write and sync
durations must not be added together. First useful action and redundant-work judgments remain
null until reviewed or qualified with the stronger identity work in M2.

The incremental accumulator deduplicates stable tool IDs and keeps authoritative final usage
separate from partial message fragments. Missing usage stays unknown, and reasoning already
included in output is not added twice. Offline counter replay uses the same counter contract.

## M1: local preflight

Default benchmark roots use `rireiDataHome()/benchmarks`:

- macOS: `~/Library/Application Support/Rirei/benchmarks`.
- Windows: `%LOCALAPPDATA%/Rirei/benchmarks`, with the existing platform fallback.
- Linux: `$XDG_DATA_HOME/rirei/benchmarks`, or `~/.local/share/rirei/benchmarks`.

`RIREI_BENCHMARK_HOME` is an explicit absolute override. New roots are canonicalized once;
provided output directories must be new and have an existing real parent. Tests cover
platform path resolution and canonical aliases.

Before preparing a batch and before each provider launch, the runtime checks the relevant
workspace, log, and budget/archive directories. The default free-space requirement is the
larger of **2 GiB** and **10 × remaining artifact allowance**, including known materialization
bytes during batch preparation. The starting allowance is 24 MiB per remaining session.

A bounded Node subprocess performs an owned write/fsync/read/delete probe. Required source
inputs are read and hashed under size/time limits before launching a provider. A failed
preflight consumes no launch reservation. The actual thresholds/readings are private metadata.

These defaults improve benchmark placement; explicit overrides still need the I/O checks.
They do not relocate a production repository or install the desktop app.

## M1: incremental visible-event writer

`trace-writer.mjs` provides a single serialized writer with stream backpressure:

| Limit                                |                          Default |
| ------------------------------------ | -------------------------------: |
| Raw/serialized record                |                          256 KiB |
| Retained visible trace               |                           16 MiB |
| Visible records                      |                           20,000 |
| Buffered diagnostic stream           |                            2 MiB |
| Sync checkpoint                      | Every 32 records and final close |
| Write/sync/capture callback deadline |                        3 seconds |

UTF-8 is decoded across chunk boundaries. Each complete, filtered, redacted JSON record is
written once; no growing-history rewrite or full-output array is required. Oversized bursts,
invalid UTF-8/JSON, stalled writes, short writes, disk errors, and failed flushes remain visible
faults. An unterminated tail is never committed as a complete event.

Received, fully written, and durably synced sequence numbers are distinct. A receiver's
incomplete capture fails its strict run gate. An intentional predecessor interruption can
retain useful durable evidence while disclosing its partial provider tail and unknown usage.

A benchmark logger fault requests termination of its own spawned provider and prevents later
launches. Production hook capture continues to use its existing journal/consent behavior;
the experimental trace writer is not a replacement for that journal.

## M1: one budget across recovery

`budget.mjs` uses a locked, fsynced, atomically published ledger. The launch is reserved before
the provider is spawned. Execution artifact references make unresolved or failed attempts
block later launches until an explicit recovery decision is recorded.

The programmatic `attachRecoveryBudget(originalRoot, recoveryRoot, decision)` operation binds
a new local recovery root to that same canonical ledger and cap. It records the reviewed prior
attempt keys, allowed unattempted keys, reason, protocol identity, and original stop-record hash.
It cannot retry an existing key, increase the cap, or erase the original incident. Reports
read the effective shared ledger and retain a snapshot for archival; no copied empty ledger
can reset the number of available attempts. There is no automatic recovery/model retry.

## Verification gates

Meaningful offline coverage includes:

- Split UTF-8, hidden-block filtering, recognized-secret redaction, and truthful source flags.
- Partial writes, zero progress, `ENOSPC`, final fsync failure, incomplete tails, malformed data,
  byte/record limits, stalled writes/callbacks, and linear output-write volume.
- Local write/readback probes, low/slow filesystem behavior, separate log-volume checks,
  canonical paths, input size/symlink rejection, and private control corruption.
- Stable tool-ID deduplication, unknown interrupted usage, and final counter replay.
- Fake-provider preflight and mid-capture failures, prompt/input parity, held-out acceptance,
  duplicate-attempt refusal, and aggregate recovery-budget conservation.

The clean checkout passed:

- `npm run verify`: TypeScript, ESLint, formatting, build, **732 passed / 3 skipped**.
- Explicit Node-global lint checks for the new and changed benchmark modules.
- Six frozen interruption-fixture checks and the offline two-way fixture validator.
- Package contents verified against the 13-file allowlist.
- Independent control copying/hash verification and historical usage replay, with zero providers.

The full suite initially caught a strict-schema issue in rebinding existing history; the
correction clones and removes the old hash before canonical rehashing. The passing process
tests cover that behavior across both provider shapes. No historical report was rewritten.

**Milestone decision:** proceed to M2's covered snapshot/receipt design. This milestone
improves measurement and failure containment; a live token or latency improvement remains
unmeasured and must use the plan's separately authorized evaluation stages.
