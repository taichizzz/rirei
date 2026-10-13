# Rirei handoff benchmark

Rirei ships an artifact-backed harness under [`benchmarks/handoff/`](../benchmarks/handoff/).
It compares a strong full-request baseline with the exact text produced by
`relay handoff --json` for eight fixed coding tasks. Each condition starts from the same
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
3. Captures one checkpoint and renders the with-notes handoff across 300, 800, and 2,000-token
   budgets (setting character limits to 4 × B) as well as the no-notes handoff capsule.
4. Copies identical repository snapshots for successor arms: baseline, handoff-no-notes, handoff-300,
   handoff-800, and handoff-2000 (`handoff-with-notes` is retained as an alias for `handoff-300`).
5. Confirms that Relay state and hidden tests are absent before each successor starts.
6. Verifies handoff prompt hashes against the captured handoff texts and detects identical prompts
   across budgets to avoid paying for duplicate provider calls via hash-based deduplication.
7. Measures successor performance and exploration metrics directly where exposed:
   tool calls made, distinct files read, time to first file edit (ms), and turns before first edit.
8. Runs public tests, a separately injected hidden test, and the combined suite after each
   successor exits.

Condition execution order rotates through balanced permutations across tasks. Identical-prompt conditions
skip provider calls via hash deduplication. The archived result records prompt hashes, repository fingerprints,
test outcomes, provider metrics, exploration metrics, note provenance, and handoff budget checks. Missing
provider metrics remain `null`; the harness never estimates them.

## Tasks

The benchmark includes 8 fixed tasks: the 5 original foundation tasks plus 3 harder tasks where a
naive baseline can fail due to rejected approaches or subtle architectural constraints:

1. `retry-after`: Nonnegative integer delay-seconds and IMF-fixdate parsing with header lookup.
2. `deep-config-merge`: Security-conscious deep plain-object merge blocking prototype pollution keys.
3. `ttl-lru-cache`: Monotonic TTL/LRU cache with lazy expiry on access and capacity eviction.
4. `workspace-path`: Symlink-safe path resolution with boundary checks and escaped traversal rejection.
5. `event-reconciliation`: Deterministic topological event reconciliation with Kahn's algorithm.
6. `json-patch-rollback`: Atomic RFC 6902 JSON patch with RFC 6901 pointer unescaping (`~0`, `~1`), array append `-`, and invertible rollback in reverse order without `JSON.parse` cloning.
7. `cursor-pagination-stream`: Async generator keyset pagination stream with URL-safe base64url encoding, deterministic `NULLS LAST` ordering for asc/desc, cycle detection, and maxItems bounding without offset/slice.
8. `sliding-window-rate-limiter`: Segmented circular ring sliding window rate limiter with atomic multi-token acquire (zero partial deduction) and exact retryAfterMs calculation without unbounded timestamp arrays.

## Run without provider calls

The default benchmark command builds Relay, runs the harness tests, and executes all eight dry-run
fixtures across all five successor conditions without invoking a provider:

```sh
npm run benchmark
```

The dry run reports `Provider commands: 0`. It validates fixture quality, the complete Relay
handoff path (both with-notes across 300, 800, and 2,000-token budgets and no-notes), repository equality,
hidden-test isolation, note capture, and identical-prompt deduplication.

The harness creates disposable repositories under the platform temporary directory's `opencode/`
child. That directory must already exist and be writable.

## Paid execution

The live experiment is separate from the default command:

```sh
node benchmarks/handoff/run.mjs --execute
```

With all eight tasks selected, this command makes up to 48 provider calls: eight Antigravity
predecessors and up to 40 cold Codex successors (five per task). Identical prompts share one
execution, so the report records the actual call count. It consumes provider quota and may incur charges. Run
it only after reviewing [`benchmarks/handoff/run.mjs`](../benchmarks/handoff/run.mjs), the selected
model IDs, authentication state, and the publication rules in the harness README.

Raw prompts, provider output, generated code, and local paths remain in the disposable run root.
Only `public-result.json` and `public-report.md` are designed for publication, and both still
require review before they are copied into the repository.

## Limits

The archived result is a small directional experiment with five synthetic tasks. The expanded
eight-task protocol has not produced a new paid result for this release. These results do not
establish statistical significance or show that Rirei generally reduces tokens, cost, or latency. Provider
versions, model behavior, authentication state, machine load, and output schemas can change the
result.

The paired totals measure successor continuation cost. They exclude the predecessor's note-capture
cost. The token totals come from provider-emitted metrics where available; the handoff-size column
uses Rirei's documented four-characters-per-token estimate.

The harness does not measure multi-agent file-collision rates or universal secret-detection
accuracy. Worktree isolation, Threads locking, and recognized-secret handling have automated tests,
but those tests do not support claims of zero collisions or 100% detection in arbitrary workloads.
