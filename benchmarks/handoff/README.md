# Rirei handoff benchmark

This harness runs the user-approved paired experiment: five Antigravity predecessor runs and
ten independent cold Codex successor runs. It compares a strong baseline prompt with the exact
text rendered by `relay handoff --json` while holding each interrupted dirty repository
checkpoint fixed.

Reports:

- [reports/2026-08-11.md](reports/2026-08-11.md) — V1 (historical negative result; control
  contamination and protocol caveats are documented in the report).
- [reports/2026-08-11-v2.md](reports/2026-08-11-v2.md) — historical pre-hardening V2 run;
  paths are redacted, and the report explicitly records that it predates full Git-state and
  pre-call hash gates.
- [reports/2026-08-12-v2.md](reports/2026-08-12-v2.md) — final hardened V2 run with complete
  preflight, dry-run, Git-state, prompt-hash, contamination, and publication-privacy gates.

## Usage

Build Relay and validate all fixtures without provider calls:

```sh
npm run build
node --test benchmarks/handoff/lib.test.mjs benchmarks/handoff/recover.test.mjs benchmarks/handoff/run.test.mjs
node benchmarks/handoff/run.mjs --dry-run
```

Execute all 15 paid/provider runs only after reviewing command metadata in `run.mjs`:

```sh
node benchmarks/handoff/run.mjs --execute
```

`--tasks N` selects the first 1-5 tasks and defaults to 5. `--timeout-ms N` controls the
per-command timeout. Default invocation and explicit `--dry-run` never invoke `agy` or `codex`.
Execution refuses to start unless the approved temp parent, built Relay bundle, provider
executables, authentication status, and configured model IDs are verified. Dry-run also gates on fixture quality, handoff budget and content
checks, successor repository hygiene, and capture-schema validity before any paid run is
allowed. Execute mode reruns all five zero-provider dry gates inside the fresh run root before
the first provider call.

## Recovery

`recover.mjs` resumes a specific interrupted five-task run without repeating actual model calls.
It has no run discovery: `--run-root` must be an exact absolute path to a direct
`handoff-benchmark-*` child of the approved temp parent. Default invocation and `--dry-run`
only inspect artifacts and print the ordered launch plan:

```sh
node benchmarks/handoff/recover.mjs \
  --run-root "$TMPDIR/opencode/handoff-benchmark-EXAMPLE"
```

Execution additionally requires the explicit `--execute` flag. Before any model call it writes
`recovery-plan.json` and refuses to exceed the experiment's 15-call ceiling. A complete log is
normally consumed even when its process exited nonzero. The sole retry exception is a strictly
verified zero-model Codex parser failure: nonzero exit, empty stdout/JSONL, all-null metrics, the
obsolete `--ask-for-approval` flag in recorded arguments, and the matching parser diagnostic.
Recovery archives those failed process attempts and their local evaluations before resetting
both condition repositories from the same predecessor. Ambiguous output or an interrupted
launch is never retried. Missing emitted metrics remain `null`; missing local evaluations may
be rerun without an agent.

Antigravity CLI can ignore the process `cwd` and operate in
`~/.gemini/antigravity-cli/scratch`. Recovery records that as a predecessor capture failure
when it occurred; it does not copy scratch edits or notes into the actual repository. New
Antigravity recovery prompts name the actual repository by absolute path and require every
edit, test, and Relay note command to target that path.

The disposable run root is created beneath the approved platform temporary directory's
`opencode/` child. Each provider run has command
metadata plus complete stdout, stderr, and JSONL logs. `result.json`, `analysis.json`, and
`report.md` are raw files that stay inside the disposable run root. `public-result.json` and
`public-report.md` remove absolute paths, raw prompts, and provider logs and are the only files
suitable for copying into `reports/`. Logs can contain model output and generated code; inspect
them before sharing. Environment variables and authentication data are not written to metadata
or copied into task repositories.

## Protocol (V2)

For each task the runner creates a dependency-free Node.js Git repository, configures only that
repository with the benchmark noreply identity, initializes Relay through the current
`dist/index.cjs`, and starts Relay with the full request. After init it asserts that ordinary
`git status --porcelain=v1 --untracked-files=all` hides `.relay/` and that
`git check-ignore -q -- .relay/state.json` succeeds. Hidden tests do not exist in the repo
during any model run.

Antigravity receives a controlled first-phase prompt that names the repository by absolute
path, requires all edits/tests/Relay commands to target that path, and demands the exact batch
note contract:

```sh
relay note import --stdin --source agent --agent antigravity
```

with a `schemaVersion: 1` JSON payload covering the fixture's expected semantic categories.
The runner validates the captured notes against `manifest.json` expectations (required types
and text needles, agent provenance, current freshness) before any successor call; a missing or
invalid capture aborts that task before either Codex run. It never synthesizes or copies notes
after the predecessor exits. It then creates a checkpoint and renders the exact handoff once.

Both successor repositories are copied from the same interrupted snapshot, physically
excluding `.relay/` and `test/hidden.test.js`. Before each successor call the runner asserts:
`.relay/` does not exist; `git status` shows no Relay path; the successor repository's full
fingerprint (HEAD, branch, index, status/diff, file modes and symlink targets, and working-tree
contents) equals the pristine predecessor copy; hidden tests are absent;
and the treatment prompt is byte-for-byte equal to the captured `handoff.text`. Baseline
receives the full request plus the same preserve-work
instruction; treatment receives only the exact rendered handoff text. No repository-local
Relay wrapper is present in either condition. Condition order alternates by task. Codex runs
are ephemeral and sequential.

After each successor exits, the runner evaluates public tests, injects the task's hidden test,
runs the hidden test alone, and runs public plus hidden tests together. The dry-run instead
confirms each initial implementation fails its public foundation, each reference solution
passes both public and hidden tests, and exercises the full product path without providers:
it runs the built Relay binary end-to-end (`init`, `start`, `note import --stdin`, `handoff
--json`), asserts `.relay` is absent from `git status` and matched by `check-ignore`, and gates
the rendered handoff at the 1,200-character/300-token budget with the task request appearing
exactly once and no note-recording instruction. It then creates both successor copies, proves
their full Git/working-tree fingerprints match, and runs the same Relay-state and hidden-test
absence gates used immediately before paid calls. Spawned children strip Node's
`NODE_TEST_CONTEXT`/`NODE_TEST_NAME` variables so `node --test` fixtures behave identically
inside the test runner.

## Results

Evidence is archived under `reports/`: `2026-08-11.md`/`.json` are the immutable V1 run, and
`2026-08-11-v2.*` preserve the first, pre-hardening V2 execution as publication-safe report,
result, and analysis files. That run finished 5/5 correct on both conditions with handoffs at
211-274 estimated tokens. Per the predeclared rule it did **not** pass: only 2/5 tasks
(`ttl-lru-cache`, `workspace-path`) reached the >=20% non-cached-token or wall-time reduction
versus the strong full-request baseline; the other three favored baseline. Compared with V1
handoffs, it was cheaper and more reliable (benchmark-defined non-cached tokens 78,402 vs
132,270; wall time 348,853 ms vs 373,642 ms; 5/5 vs 4/5 correct). Because that execution
predates the full HEAD/index/diff and pre-call hash gates, it is directional historical evidence,
not the final compliant V2 result.

The final hardened `2026-08-12-v2.*` run completed all 15 intended provider calls with zero
failures/retries, 5/5 correct in both conditions, 5/5 exact prompt hashes, and no Relay-state or
successor-gate failures. Treatment used 101,008 benchmark-defined non-cached successor tokens
versus baseline's 87,455 (+15.5%) while finishing in 288,487 ms versus 299,322 ms (-3.6%). Only
`workspace-path` reached the >=20% threshold, so the predeclared 3/5 decision rule did not pass.

## Measurement and interpretation

The result records wall time, exit status, test outcomes, emitted input/cached/output/reasoning
tokens, model turns, tool calls, successor changed lines, handoff size/omissions, note
type/provenance/freshness, task-specific rejected-approach detection, and the V2 integrity
fields: `relayStatePresentBeforeSuccessor`, `relayPathInGitStatus`, `conditionFingerprintEqual`,
`captureValidated`, `capturedNoteTypes`, `handoff.duplicateTaskOccurrences`,
`handoff.containsNoteInstruction`, and prompt SHA-256 for both conditions. Metrics not present
in provider JSONL are `null`; they are never estimated. The report gives paired deltas,
means/medians, correctness counts, integrity proof, and caveats.

The predeclared decision rule is: treatment must maintain correctness and reduce non-cached
tokens or wall time by at least 20% on at least 3/5 tasks, with no misleading handoff-caused
failure. A treatment failure leaves the causal-review field `null`, so the rule cannot pass
without manual review. This small, fixed benchmark is directional evidence only. It does not
support a claim of statistical significance, and model/provider updates, authentication state,
machine load, and JSONL schema changes remain limitations.

The V2 experiment measures successor continuation cost, not total end-to-end workflow cost:
predecessor capture tokens are recorded separately and are not part of the paired successor
deltas.

Provider use may incur cost and consume quota. The harness makes exactly three provider calls
per selected task and performs no network-dependent setup; provider CLIs may still use their
normal remote services during `--execute`.
