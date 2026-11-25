# Continuity results

Reports here contain reviewed aggregate/per-case metrics and hashes, without raw prompts,
commands, absolute host paths, or provider thread IDs. Archive raw trial artifacts privately
for later trace review; a temporary run directory is not a durable archive. Reports record
known retention limits separately from the original run results.

`analyze.mjs --run-root <private-run> --output-directory <new-report-directory>` derives
analysis from recorded logs without launching providers or altering the original report.
Every report must distinguish fixture checks, synthetic successor trials, and actual
cross-provider experiments. Token estimates and provider-emitted counters have different meanings.

For the real two-way schema, use `analyze-cross.mjs` through `node --import tsx`. It verifies
saved inputs and visible traces without provider calls; see the
[2026-11-02 results](2026-11-02-bidirectional.md).

The [requirement-first candidate replay](requirement-preservation-replay.md) is an offline
preservation check. Its results must not replace the original live correctness scores.

The [receiver-only live retest](requirement-first-live-retest.md) records 4/4 acceptance passes
for both methods. It separately retains one Rirei storage/capture incident and reports clean
matched-pair performance, rather than treating that session as a clean success.
