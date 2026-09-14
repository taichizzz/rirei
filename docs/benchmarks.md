# Rirei handoff benchmark

Rirei ships an artifact-backed harness under [`benchmarks/handoff/`](../benchmarks/handoff/).
It compares a strong full-request baseline with the exact text produced by
`relay handoff --json` for five fixed coding tasks. Each condition starts from the same
interrupted repository snapshot and is evaluated with public and hidden tests.

## Recorded result

The final hardened V2 run was recorded on 2026-08-12. It completed all 15 intended provider
calls without failures, timeouts, or retries.

| Measure                          | Full-request baseline |  Rirei handoff |
| :------------------------------- | --------------------: | -------------: |
| Correct tasks                    |                   5/5 |            5/5 |
| Non-cached successor tokens      |                87,455 |        101,008 |
| Successor wall time              |            299,322 ms |     288,487 ms |
| Generated handoff size           |                   n/a | 211-274 tokens |
| Tasks reaching the 20% threshold |                   n/a |            1/5 |

The Rirei condition used 15.5% more non-cached successor tokens and finished 3.6% faster
overall. The predeclared decision rule required at least three of five tasks to preserve
correctness while reducing non-cached tokens or wall time by at least 20%. Only one task met
that threshold, so the rule did not pass.

The public evidence is checked in with the source:

- [Final report](../benchmarks/handoff/reports/2026-08-12-v2.md)
- [Publication-safe result](../benchmarks/handoff/reports/2026-08-12-v2.json)
- [Publication-safe analysis](../benchmarks/handoff/reports/2026-08-12-v2.analysis.json)
- [Harness protocol and historical reports](../benchmarks/handoff/README.md)

## What the harness controls

For each task, the harness:

1. Creates a dependency-free Git repository from a checked-in fixture.
2. Runs a controlled predecessor and validates the notes it records.
3. Captures one checkpoint and renders the treatment handoff once.
4. Copies identical repository snapshots for the baseline and treatment successors.
5. Confirms that Relay state and hidden tests are absent before each successor starts.
6. Verifies the treatment prompt hash against the captured handoff.
7. Runs public tests, a separately injected hidden test, and the combined suite after each
   successor exits.

Condition order alternates by task. The archived result records prompt hashes, repository
fingerprints, test outcomes, provider metrics, note provenance, and handoff budget checks.
Missing provider metrics remain `null`; the harness does not estimate them.

## Run without provider calls

The default benchmark command builds Relay, runs the harness tests, and executes all five dry-run
fixtures without invoking a provider:

```sh
npm run benchmark
```

The dry run reports `Provider commands: 0`. It validates fixture quality, the complete Relay
handoff path, repository equality, hidden-test isolation, note capture, and the 1,200-character / 300-token
handoff budget.

The harness creates disposable repositories under the platform temporary directory's `opencode/`
child. That directory must already exist and be writable.

## Paid execution

The live experiment is separate from the default command:

```sh
node benchmarks/handoff/run.mjs --execute
```

With all five tasks selected, this command makes exactly 15 provider calls: five Antigravity
predecessors and ten cold Codex successors. It consumes provider quota and may incur charges. Run
it only after reviewing [`benchmarks/handoff/run.mjs`](../benchmarks/handoff/run.mjs), the selected
model IDs, authentication state, and the publication rules in the harness README.

Raw prompts, provider output, generated code, and local paths remain in the disposable run root.
Only `public-result.json` and `public-report.md` are designed for publication, and both still
require review before they are copied into the repository.

## Limits

This is a small directional experiment with five synthetic tasks. It does not establish
statistical significance or show that Rirei generally reduces tokens, cost, or latency. Provider
versions, model behavior, authentication state, machine load, and output schemas can change the
result.

The paired totals measure successor continuation cost. They exclude the predecessor's note-capture
cost. The token totals come from provider-emitted metrics where available; the handoff-size column
uses Rirei's documented four-characters-per-token estimate.

The harness does not measure multi-agent file-collision rates or universal secret-detection
accuracy. Worktree isolation, Threads locking, and recognized-secret handling have automated tests,
but those tests do not support claims of zero collisions or 100% detection in arbitrary workloads.
