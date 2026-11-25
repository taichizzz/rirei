# Continuity evaluation

The [M0–M1 efficiency milestone](../../docs/handoff-efficiency-m0-m1.md) adds a frozen
requirement-first control, local-runtime preflight, bounded incremental event logging,
host-observed timing, and a shared recovery ledger. The
[control identity](controls/requirement-first.json) pins historical results rather than
the moving active source. These infrastructure changes have no new live quality score.

The [2026-11-17 offline working-copy run](reports/2026-11-17-offline.md) records current
preparation timings, exact targeted-retrieval volume, saved-case requirement preservation,
and synthetic prompt comparisons. All six stages passed with zero provider sessions.

The [2026-11-18 E1 live smoke](reports/e1-2026-11-18.md) used its eight authorized receivers.
Frozen control and current candidate each passed 4/4 strict cases. Efficiency was mixed, native
helper PATH resolution needs qualification, and no faster/cheaper default was promoted.

The [2026-10-29 engineering pilot](reports/2026-10-29-pilot.md) used all 12 approved successor
sessions. All arms passed 3/3 tasks; V2 had smaller prompts but no demonstrated correctness
or cost advantage. Running the live command again consumes a new budget.

The [2026-11-02 two-way pilot](reports/2026-11-02-bidirectional.md) completed after sign-in
and an authorized replacement of the [initial zero-token authentication failure](reports/2026-11-02-bidirectional-preflight.md).
Full history passed 4/4 cases; Rirei passed Claude → Codex 2/2 and failed Codex → Claude 0/2.
The compact selector omitted acceptance requirements. Keep it experimental until that is fixed.

The [post-pilot requirement-first candidate](reports/requirement-preservation-replay.md) restores
all six complete requirement strings in each saved handoff during a zero-provider replay.
That replay preceded live validation; the original 2/4 result remains unchanged.

The [fresh receiver-only retest](reports/requirement-first-live-retest.md) now has Rirei
acceptance passes on 4/4 cases, matching full history. One Rirei run had disk/logging errors,
so strict successful runs are 3/4; clean paired efficiency results exclude that pair.

## Offline fixture validation

```sh
npm run benchmark:continuity
```

Checks the six frozen interrupted snapshots against their reference implementations and
acceptance checks. It makes no provider calls and does not measure model quality.

## E1 frozen-control comparison

`e1.mjs --control <private-frozen-control-directory>` prepares eight paired inputs without
launching models. It verifies the historical archive, copies both compiled CLIs, renders complete
handoffs, restricts the explicit helper to read-only context commands, and freezes the protocol,
source/bundle identities, versions and scoring rules. `--output <new-directory>` selects a new
owned local runtime directory. `--execute --run-root <prepared-directory> --case-index <0–3>`
launches a pair through the shared eight-attempt ledger; `--finalize --run-root <directory>` grades
retained work without models. Execution always needs its own explicit authorization; the linked
E1 run has spent all eight attempts. A failure stops later launches and never grants a replacement.

The native run exposed login-shell PATH shadowing. New preparations direct all context lookups
through `./.benchmark-tools/relay` from the authorized workspace and check each pinned build with
an actual task lookup before finalizing the prompt. The saved E1 report and private as-tested
source archive still describe the original run.

### Lookup-dependent handoff rehearsal

```sh
npm run build
node --import tsx benchmarks/continuity/lookup-handoff.mjs
```

In a disposable partner-export fixture, a late correction points to a failed compatibility probe.
The exact label is present only in the cited journal record, and a passing pre-edit test receipt
is shown as stale. The same scripted receiver takes the lookup command from the handoff. With a
shadowed bare `relay` it cannot retrieve the label; with the explicit helper it reads a bounded
evidence window, finishes the export, and runs a fresh public check. A separate acceptance check
compares the export with the exact retained label. This POSIX rehearsal uses the compiled CLI and
zero provider sessions.

The [single-receiver live smoke](reports/lookup-live-2026-11-18.md) then passed on a fresh copy
of the fixture. Codex used the pinned lookup path, followed the correction, and ran a fresh
verification of the final implementation without operator follow-up.

The [T3 Code preflight](reports/t3-handoff-preflight-2026-11-25.md) used the same interrupted
checkpoint files and evidence. T3's provider switch carried the failed probe output when it was
recorded in a managed thread; its saved Claude transcript import kept the messages but dropped
the tool result. The preflight used mock providers.

The [matched live pair](reports/t3-live-head-to-head-2026-11-25.md) then ran one Codex receiver
per product on the same checkpoint and evidence. Both passed with byte-identical code. T3 Code
finished sooner; Rirei reported fewer non-cached tokens. Cache state was uncontrolled.

## M3 inspection qualification

```sh
node --import tsx benchmarks/continuity/inspect.mjs
node --import tsx benchmarks/continuity/inspect.mjs --control <private-frozen-control-directory>
```

This offline-only command measures full handoff/inspection preparation on declared local
fixtures. With `--control`, it also verifies the frozen requirement-first files/history and
replays all four saved cases in disposable repositories. It launches zero providers and reads
the control archive without modifying it. The numeric/hash-only
[M3 report](reports/m3-inspection.json) retains all samples and as-tested source hashes.
See [M3 milestone notes](../../docs/handoff-efficiency-m3.md) for bounds and interpretation.

## M4 targeted retrieval qualification

```sh
npm run build
node --import tsx benchmarks/continuity/retrieve.mjs
node --import tsx benchmarks/continuity/retrieve.mjs --control <private-frozen-control-directory>
```

The compiled CLI retrieves preselected source ranges from an authored 43-record/two-file workload.
The script measures actual returned UTF-8 bytes and executed read commands, checks exact source
equality, and can replay the four frozen requirement-preservation cases. It has no live-provider
mode. See the [numeric report](reports/m4-retrieval.json) and
[M4 milestone notes](../../docs/handoff-efficiency-m4.md) for the measured scope and limits.

## M5 output/layout preparation

```sh
node --import tsx benchmarks/continuity/policies.mjs
node --import tsx benchmarks/continuity/policies.mjs --control <private-frozen-control-directory>
node --import tsx benchmarks/continuity/policies.mjs --contrast layout --repetitions 2
```

This offline-only command checks four rendering profiles, preserves saved requirements/evidence,
and records common UTF-8 prefix diagnostics plus a hashed AB/BA schedule. `--report <new-file>`
writes an exclusively created numeric report. `--observations <saved-json-array>` analyzes
explicitly supplied observation metadata/visible JSONL without launching a provider.

The [M5 report](reports/m5-policies.json) has zero live observations: cache/output/receiver-time
benefit remains unmeasured. Proposed eight-launch single-contrast schedules have zero authorized
launches; repetition/contrast changes require explicit aggregate budget accounting. See
[M5 notes](../../docs/handoff-efficiency-m5.md) for semantics, qualification, and live-gate limits.

## Before/after context comparison

```sh
npm run benchmark:handoff
```

Prepares three synthetic cases and four inputs per case, without starting a model:

- `request-repository`: initial request and repository, intentionally without later history.
- `full-history`: the entire available synthetic history.
- `rirei-v1`: the renderer frozen before compact briefings.
- `rirei-v2`: the current compact, source-cited briefing.

The cases are a repository-sufficient control, a long message with a late correction, and a
failed command followed by an edit and an unsupported success claim. These are small engineering
fixtures, not a representative software-engineering sample. The history was authored, not
captured from a live Claude predecessor. The history-bearing arms can retrieve the same
underlying records; request-only is a separate information-access control.

All arms begin with byte-identical source/public-test files. Git snapshots, source-history
hashes, and actual prompt hashes are recorded. Trial order rotates by case. Gold acceptance
drivers run only after all successors stop, outside their working directories. This is not
an adversarial read-isolation environment; live tasks must stay within their supplied workspace.

### Frozen baseline

`baselines/rirei-v1.ts` is the exact pre-change `src/context/render.ts`, Git blob
`134e19a55f469d791d7e27dce4741987806950b4`. The adjacent schema/store re-exports let it read the
same records as the current renderer. Do not reformat or modify the frozen file. The runner
verifies its bytes before preparing a comparison.

### Approved live pilot

```sh
npm run benchmark:handoff -- --execute --model gpt-5.6-sol --effort low --timeout-ms 180000
```

This path starts at most **12 fresh Codex successor sessions**, three cases × four arms,
with low reasoning effort and a three-minute timeout per session. It uses the existing Codex
authentication, ephemeral sessions, workspace-write sandboxing, no networking in tool sandboxes,
and disabled hooks/memory/plugins/multi-agent features. The runner does not use bypass flags or
automatically rerun a failed session. Confirmed authentication/model/quota failures stop later
sessions. This budget is a session/runtime bound, not a dollar or internal API-request cap.

Use an existing writable `os.tmpdir()/opencode` parent. The default creates a new private run
directory there. `--output <new-directory>` requires a new destination under an existing parent.
Raw prompts, commands, stdout/stderr, workspaces, and progress stay in that private directory.
`report.json` contains the aggregate and per-case measurements; review it before publishing.
Temporary files may be removed between sessions. Use `--output` with a durable private
destination for runs whose raw artifacts must remain available for later trace review.

Analyze saved traces without starting a provider:

```sh
node benchmarks/continuity/analyze.mjs --run-root <private-run-directory>
```

The analyzer keeps cached input, total input, output, and non-cached usage separate and
exports only selected numeric fields/hashes. `--output-directory <new-directory>` writes a
reviewable analysis without changing the original report or raw traces.

### Interpretation

- Report correctness, failures/timeouts, latency, and provider-emitted usage together.
- Non-cached tokens are input minus cached input plus output, not an authoritative subscription
  quota measurement or a dollar bill. Missing provider counters remain `null`.
- Character counts and characters/4 estimates describe supplied context only.
- Inline target presence measures selection behavior, not whether a successor obeyed it.
- Context rendering time is measured. Real predecessor capture and human preparation/repair
  costs are unmeasured, not zero. No model is used to prepare these synthetic histories.
- This pilot does not compare an actual Orca runtime, an agent-written `HANDOFF.md`, a real
  Claude-to-Codex transfer, or repeated trials. Those remain separate experiments.
- Blinded trace review is needed for useful-action latency, unnecessary questions, repeated
  approaches, and unsupported claims. Passing acceptance checks is not a score for all of these.

The original five-arm research protocol remains in `protocol.json`. This four-arm engineering
pilot is a before/after test and does not replace that broader evaluation.

## Real two-way pilot

```sh
npm run benchmark:cross
```

The default validates two multi-file fixtures without starting providers. The live design
uses four predecessors (two tasks × two directions), each followed by Rirei and full-history
receivers: **12 launch attempts total**, including predecessors. Claude uses `sonnet` / low;
Codex uses `gpt-5.6-sol` / low. Record the resolved models and compare within each receiver.

`bidirectional.mjs --execute --output <new-private-directory> --case-index 0` starts the first
case; later case indices use `--run-root <exact-existing-directory>`. Execution requires an
explicit fresh budget. The runner records each launch before spawning it, refuses repeated
session keys, and stops after provider/capture failures. A stopped run is not automatically
retried. Retain its ledger and account for prior attempts when authorizing a replacement.

Artifacts go to the supplied durable private directory; the current attempt uses the ignored
`.relay/benchmarks/` parent. `--finalize --run-root <directory>` grades saved work without
launching models. The full-history arm receives all retained visible evidence, with the same
capture bounds/redactions as Rirei. Hidden reasoning is excluded from both.

Claude predecessors use the production session-local hooks. Codex predecessors use the new
passive exec JSON observer; this does not enable general interactive Codex capture. The
predecessor is deliberately limited to its first helper stage before interruption, so this
tests a controlled partial implementation rather than a naturalistic user interruption.

Audit the saved two-way run without starting a model:

```sh
node --import tsx benchmarks/continuity/analyze-cross.mjs --run-root <private-run-directory> --prior-failed-launches 1
```

`--output-directory <new-directory>` writes a numeric/hash-only export. The analyzer replays
provider counters, verifies paired inputs and history integrity, checks frozen predecessor
files, and reports requirement-string coverage and stale-path references. These diagnostics
do not establish semantic completeness or adversarial filesystem isolation.

Re-render the saved handoffs with the current candidate without launching providers or
changing the original results:

```sh
node --import tsx benchmarks/continuity/replay-cross.mjs --run-root <private-run-directory>
```

Use `--output-directory <new-directory>` for a privacy-reviewed replay export. The output
keeps original live correctness separate from the unknown candidate live correctness.

## Fresh receivers on saved checkpoints

`receivers.mjs --source-run <original-private-run> --output <new-private-directory>` prepares
eight receivers without starting models. It verifies the original report, checkpoint files,
and linked evidence, and gives both methods an explicit current workspace.

`--execute --run-root <prepared-directory> --case-index <0–3>` launches the two receivers for
one case. Its ledger enforces an eight-attempt cap and refuses duplicate keys. Provider or
capture failures stop the run. Execution requires a fresh agreed budget; the linked retest
has used all eight attempts.

`--finalize --run-root <directory>` grades saved implementations without provider calls.
Keep acceptance distinct from infrastructure-affected run validity, and exclude both sides
of an affected pair from clean performance comparisons.
