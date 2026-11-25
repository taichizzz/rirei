# Handoff efficiency: M5 output/layout preparation

Status: **Implementation and offline qualification complete; live output/layout ablation pending.**\
Date: 2026-11-11\
Plan: [handoff-efficiency-plan.md](handoff-efficiency-plan.md).

Subsequent evaluation (2026-11-18): [E1 completed eight receivers](../benchmarks/continuity/reports/e1-2026-11-18.md),
with 4/4 strict cases for both frozen control and default candidate. Helper-routing limits and
mixed efficiency prevent promotion. E1 disabled the profiles below; their live benefit remains
unmeasured. The pending-gate statements in this milestone record describe its 2026-11-11 state.

## Scope and milestone naming

This delivery implements Phase 5's receiver-output and stable-layout candidates, plus balanced
experiment planning and saved-observation analysis. The earlier milestone table called the live
smoke “M5” and the ablation “M6”; those evaluation gates are now consistently identified as
**E1/E2**, separately from implementation milestones. This offline delivery does not satisfy
either live gate, establish a winning candidate, or grant a new provider-session budget.

The implementation is local and unreleased. Alpha.5.1 downloads do not include it.
Build this checkout with `npm run build` and use its `dist/index.cjs` CLI for the previews below.

## Rendering profiles

```sh
relay handoff --profile control --json
relay handoff --profile focused-output --json
relay handoff --profile stable-layout --json
relay handoff --profile stable-focused --json
```

| Profile          | Treatment                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `control`        | Existing M2–M4 handoff composition; the default                                               |
| `focused-output` | Adds a short provider-neutral receiver output policy                                          |
| `stable-layout`  | Reorders already-selected content into static, authority/task, evidence, and runtime sections |
| `stable-focused` | Combines both treatments for an explicitly named later contrast                               |

Profiles are rendering/preview controls on `handoff`, not new `run`/`switch` launch options.
No profile is persisted to task state or silently activated for provider launches. Native switch
promotion remains a separate gate. `renderHandoffDocument()` accepts the same optional profile
for offline candidate preparation.

The focused policy says:

> Follow the submitted task requirements, including any requested output.\
> Make focused edits; use patches when practical and full-file replacement when simpler.\
> Run relevant checks and retain useful failure diagnostics.\
> Finish with changed behavior, verification, and unresolved uncertainty; keep the recap concise unless the task asks for more.

It does not impose a generated-token limit, suppress diagnostics, force patches when replacement
is simpler, or request a second detailed handoff at completion. Explicit task/output requirements
remain controlling.

## Preservation and budget contract

Every candidate starts with the control's selected capsule/evidence. It does not rerank or
compress instructions to make policy text fit. Whole submitted messages, repeated submissions,
chronology, citations, exact excerpt ranges, pending outcomes, unverified claims, and capture
warnings remain represented. Disabled capture stays excluded.

All additional prompt characters are charged to remaining **legacy capsule headroom**, within
its existing configured character/token ceilings. The existing 6,000-character evidence ceiling
is not enlarged or borrowed from. If the candidate cannot fit, or a very small truncated capsule
cannot safely be rearranged, the result retains the complete control rendering.

`handoff --json` includes versioned `policy` metadata for a requested candidate:

- Requested/effective profile, applied status, and fallback reason.
- Control/final text hashes, added characters, and legacy-budget accounting.
- Layout/output-policy versions and the exact static-prefix byte count/hash.
- `cacheBenefit: unmeasured`.

Plain-text output reports a fallback on stderr. In stable-layout JSON, `text` is the actual
composed candidate prompt; `continuity.text` retains the control-selected briefing for source
auditing, together with unchanged selected-evidence and coverage metadata. It is not necessarily
a contiguous substring of the reordered candidate.

The stable layout keeps the canonical current workspace early, before task/evidence content.
Git/capture metadata and runtime warnings move to a labeled trailing section. Source IDs remain
with their evidence even when that limits prefix reuse. An authority path that cannot fit causes
fallback rather than silent shortening. Nothing is removed merely to increase common bytes.

## Offline saved-case result

[The numeric/hash-only report](../benchmarks/continuity/reports/m5-policies.json) uses independently
verified copies of the four saved requirement-first cases. All four profiles preserve **6/6
original requirements on every case**, with identical selected evidence, coverage warnings,
snapshot identity, and capsule content relative to the current control.

All three candidates fit on these four inputs:

| Profile          | Added prompt characters per saved case |
| ---------------- | -------------------------------------: |
| `focused-output` |                                    386 |
| `stable-layout`  |                                     73 |
| `stable-focused` |                                    459 |

These are added input characters, not observed reductions in generated output or paid usage.
The largest combined candidate used 5,948 characters across the capsule and evidence prompt,
inside its existing combined ceiling.

A synthetic runtime-metadata probe appends one session-end event only in each disposable copy.
Selected evidence stays identical, while capture metadata changes. Under this probe, control
prompts shared **823–841 UTF-8 prefix bytes** and stable-layout prompts shared **4,040–5,197**.
This is a presentation diagnostic. It is not provider tokenization, a cache-hit counter, or proof
of cross-session cache reuse. Added static policy text can itself lengthen a shared prefix while
increasing input cost. Cache creation/read, receiver output/reasoning, non-cached usage, and
receiver wall time remain **null/unmeasured** in this report.

Original control files, archived CLI/renderer bytes, and historical live results are preserved.
M5 used **zero live provider sessions**.

## Balanced experiment preparation

```sh
node --import tsx benchmarks/continuity/policies.mjs
node --import tsx benchmarks/continuity/policies.mjs --control <private-frozen-control-directory>
node --import tsx benchmarks/continuity/policies.mjs --contrast layout --repetitions 2
```

The command has no live execution mode. It validates authored or saved cases, renders all
profiles, produces prefix diagnostics, and emits a hashed proposed experiment. `--report
<new-file>` writes the complete numeric report using exclusive creation. `--observations
<saved-json-array>` additionally analyzes explicitly supplied prior observation metadata and
visible JSONL; it does not discover sessions or launch providers.

Each experiment isolates one contrast: `output`, `layout`, or explicitly `combined`. With four
checkpoints and one repetition it proposes **8 launches**, rotating AB/BA across the two tasks
within each receiver. A second repetition inverts per-case order and proposes **16 total**;
three repetitions propose 24. `authorizedLaunches` remains **0**. Running two separate eight-launch
contrasts would require accounting for all sixteen attempts, not reusing one eight-session budget.
These plans do not replace the governing E1/E2 budgets without a separately agreed amendment.

Provider-managed cache state is declared **uncontrolled**. Credentials and caches are not changed.
Future execution must record CLI version, model/effort, actual start/end times and elapsed spacing,
prompt/source hashes, and all consumed attempts through the existing shared-ledger discipline.
No documented cold-cache control has been established.

## Saved-observation analysis

`policy-experiment.mjs` accepts an array of strict metadata records, each containing:

- The exact `protocolHash` and scheduled key, provider, CLI version, requested model, effort,
  and nullable resolved model.
- Nullable start/end timestamps and wall time; completion/infrastructure status, acceptance,
  strict-success/trace-completeness flags, and whether the requested candidate actually applied.
- The explicitly supplied bounded visible JSONL stream used to replay provider counters.

Unknown metadata is null. Changed plans/source versions, duplicate keys, unscheduled attempts,
runtime mismatch, profile fallback, failed/incomplete outcomes, provider-reported errors, or
wrong/unknown timing cannot become qualified paired results. An invalid attempt remains visible;
there is no “best retry” substitution.

Normalization reuses M0's provider-specific measurement parser. Cache creation, cache read,
output, and reasoning remain separate. Missing creation counters stay null, including providers
that do not expose them. Output-inclusive reasoning is never added a second time. Invalid or
inconsistent counters become unknown. Unresolved model identity is explicitly requested-model-only.

Reports retain per-pair reasons, actual elapsed spacing, metric-specific sample counts, and
same-runtime clean matched subsets. Different receiver versions/models/efforts are not pooled.
A descriptive replicated cache pattern requires complete balanced repeated cases, exposed read
counters, improved read fraction/count, and no measured non-cached/output/tool/time regression.
Even this descriptive pattern is not significance, controlled cold-cache evidence, or automatic
promotion. With no observations, both receiving providers remain `unmeasured`.

## Verification and decision

TypeScript, ESLint, formatting, and build passed. The complete serial suite passed **850 tests /
3 skipped**, including **26 new regressions** for preservation, fallback/budget behavior, workspace
authority, default compatibility, CLI previews, prefix diagnostics, balanced planning, unknown
counters, runtime/order/trace exclusions, and output/latency regression handling.

The initial default-parallel run hit a message-lock failure and the harness time limit. A four-worker
run also hit short snapshot/message-lock deadlines under host load. The unchanged message test
passed alone; the full suite then passed with one worker and a quiet JSON reporter. Production
deadlines and test assertions were not relaxed. Successful full-suite invocation:

```sh
npm test -- --maxWorkers=1 --reporter=json --outputFile=<temporary-report-file>
```

Six interruption fixtures, both offline two-way workflow validators, package contents, and explicit
Node-global lint for the new benchmark modules passed. Packed global CLI install, first-task TUI,
daemon/PTY, reinstall, and uninstall smoke also passed in temporary installation directories.

**Decision:** the output/layout candidates and offline experiment controls are ready for review.
E1 correctness smoke and E2 ablation still require separate authorization and execution. Receiver
token/output/cache/latency benefit is unmeasured, so no profile is promoted as a winning default.
