# Real two-way handoff pilot — 2026-11-02

## Decision

Follow-up: the [requirement-first candidate](requirement-preservation-replay.md) repairs the
observed omissions in an offline replay. The scores below describe the original tested source;
the [subsequent receiver-only retest](requirement-first-live-retest.md) records the candidate's
new results separately, including its storage incident.

**The current compact briefing failed the correctness gate in Codex → Claude.**
Full retained history passed all four paired cases; Rirei passed both Claude → Codex cases
and failed both Codex → Claude cases. Keep automatic continuity experimental. Fix submitted
requirement preservation and historical-path handling before another paid comparison.

The recorder and source lookup worked with real CLI predecessors in both directions.
That transport result does not establish reliable semantic handoff or an overall cost win.

## Execution and scope

- **12 completed experiment launches:** four predecessors and eight receivers. Each of two
  authored multi-file tasks was run once in each direction, with two receiver methods per checkpoint.
- The [initial authentication failure](2026-11-02-bidirectional-preflight.md) remains recorded.
  After sign-in, the user authorized one replacement: **13 aggregate launch attempts**, including
  the original zero-token failure. No automatic reruns or unapproved extra model sessions occurred.
- Claude Code **2.1.258**, requested model `sonnet`, resolved **`claude-sonnet-5`**, effort **low**.
- Codex CLI **0.153.4**, requested model **`gpt-5.6-sol`**, effort **low**. The exec JSON stream
  did not independently emit a resolved model identifier.
- Predecessors were instructed to implement only the first helper stage. Each was interrupted
  after a captured source edit, leaving a genuinely incomplete implementation. This is a controlled
  partial-work experiment, not a naturalistic interruption study.
- Both receiver methods started from byte-identical frozen files and could retrieve the same
  retained evidence. Receiver order rotated by case. Full history means the entire retained
  visible journal, with the same bounds and redactions as Rirei; hidden reasoning is excluded.
- Claude predecessors used production session-local hooks; Codex predecessors used the new
  passive exec JSON observer. The runner launched fresh noninteractive receivers, not the
  application's interactive switch UI. Claude used a fixed custom system prompt in both arms.
- Receivers had a 180-second limit. All eight exited successfully, with no timeouts or provider
  errors. Correctness was graded separately, after the live sessions ended.

## Held-out correctness

| Direction      | Task          | Full history | Rirei | Rirei acceptance groups |
| -------------- | ------------- | ------------ | ----- | ----------------------- |
| Claude → Codex | Tenant ledger | Pass         | Pass  | 7/7                     |
| Claude → Codex | Cursor feed   | Pass         | Pass  | 7/7                     |
| Codex → Claude | Cursor feed   | Pass         | Fail  | 5/7                     |
| Codex → Claude | Tenant ledger | Pass         | Fail  | 4/7                     |

Each task has six behavioral acceptance groups and one provided-file integrity group.
All four predecessor checkpoints failed the behavioral acceptance checks before continuation.
All eight receivers preserved the provided tests and package metadata. All evidence-integrity
checks and replayed history hashes passed; frozen predecessor files remained unchanged.

### Missed behavior

- **Cursor feed:** Rirei's receiver accepted limits above 50 and returned references to input
  records. It failed `limits-and-empty` and `defensive-copies`.
- **Tenant ledger:** Rirei's receiver overwrote duplicates, accepted fractional numeric values,
  and retained/exposed mutable row objects. It failed `duplicate-first-wins`, `atomic-validation`,
  and `defensive-copies`. The validation group includes several assertions; the observed fractional
  amount acceptance is enough to fail it even though some batch rollback behavior was implemented.
- Both failed receivers passed the small public test and described their work as verified.
  Public-test success and successful process exit therefore did not imply acceptance compliance.

## Receiver measurements

Totals below cover the two tasks within each direction, including failed continuations.
Tokens are not pooled across receiving providers.

| Direction      | Context      | Correct | Prompt chars | Total input | Cached input | Output | Non-cached input + output | Tool calls | Receiver wall time |
| -------------- | ------------ | ------: | -----------: | ----------: | -----------: | -----: | ------------------------: | ---------: | -----------------: |
| Claude → Codex | Full history |     2/2 |       24,699 |     201,911 |      143,104 |  6,273 |                    65,080 |          8 |           71.622 s |
| Claude → Codex | Rirei        |     2/2 |        9,909 |     145,378 |      121,472 |  6,003 |                    29,909 |          6 |           74.995 s |
| Codex → Claude | Full history |     2/2 |       21,508 |     287,279 |      264,374 |  6,914 |                    29,819 |         18 |          122.022 s |
| Codex → Claude | Rirei        |     0/2 |       10,356 |     325,775 |      304,800 |  9,012 |                    29,987 |         25 |          117.290 s |

For Codex, non-cached usage is reported input minus cached input plus output. For Claude,
total input here includes fresh input, cache creation, and cache reads; non-cached input plus
output includes fresh input, cache creation, and output. Claude cache creation totals were
22,871 for full history and 20,931 for Rirei. Reasoning counters remain separate and are not
added to output twice. Neither metric is an authoritative subscription-quota or dollar bill.

Rirei's smaller prompts and lower Codex-receiver token counts are sample observations. Cache
reuse varied substantially, and the two Claude-receiver failures invalidate a general efficiency
claim. Predecessor final usage counters were unavailable after interruption; total lifecycle
cost and human effort remain **unknown**, not zero.

## Trace diagnosis

### Submitted requirements were available but omitted inline

The submitted predecessor prompts were only **1,577** and **1,599 characters**. The tested
briefing nevertheless split messages longer than 900 characters into excerpts and selected
the last four instruction-cue spans, along with the first and last spans. In these tasks,
the trailing first-stage/setup instructions displaced the detailed acceptance requirements.

All four compact prompts contained **0/6 complete requirement strings**, while all four
full-history prompts contained **6/6**. This is a lexical diagnostic, not a semantic score;
manual inspection also confirmed the missing page-limit, duplicate, numeric-validation,
and copying requirements in the failed receiver prompts.

Both Codex receivers recovered the complete submission using `relay context history` and
passed. Neither Claude receiver retrieved submitted-message history or a cited source:
one queried only `relay context task`, which returned the initial brief and empty structured
requirement fields. Both then implemented an incomplete interpretation of the task.

The matching omissions and implementation failures identify a concrete selection problem.
One trial per cell does not isolate its causal effect from every other difference or rank
the providers' general abilities.

### Historical absolute paths confused receivers

Both Rirei Claude receivers followed stale absolute predecessor paths. The cursor case made
one shell call and two file-tool attempts referencing the predecessor; the ledger case made
two shell calls and two file-tool attempts. Restricted file tools rejected the out-of-workspace
accesses; shell commands still read predecessor files. The receivers later recovered their
actual working directories.

No other-workspace literal references were found in the six other receiver traces. Recomputed
frozen-file hashes show the predecessor checkpoints were not changed. The inspected shell
reads exposed the same incomplete predecessor files, not another receiver's solution. This
was **not an adversarial read-isolation test**. The custom Claude system prompt and missing
explicit current-workspace path in the shared task prompt also limit production generalization.

## Reproducibility and retained artifacts

[Reviewed numeric analysis](2026-11-02-bidirectional/analysis.md) and
[per-case counters, audits, and hashes](2026-11-02-bidirectional/analysis.json) are included.
The original private report SHA-256 is
`933ec7cefc796d5f380589f89291c157d9f5628a2b9df3da9fabde4324e8f735`.

The tested briefing SHA-256 is
`9134ffefb1062afd0b8f72482dca633c4d3bf4f9bfb26e31a4f97471f272db5b`;
runner and fixture source hashes are in the analysis. These identify the tested local source,
not a released commit. The core briefing was not changed during this experiment or analysis.

Private originals remain under the ignored, durable project-local directory
`.relay/benchmarks/bidirectional-2026-11-02-after-login/`. It contains the protocol and session
ledger, frozen files/history, prompts, filtered visible provider events, command metadata,
workspaces, and grading outcomes. Public exports omit prompts, commands, account details,
absolute host paths, and provider session identifiers. Saved-trace replay reproduced usage
counters, prompt hashes, paired input hashes, and source-history integrity without provider calls.

## Next gate

1. Preserve complete submitted requirements when they fit the available budget; prioritize them
   over historical setup boilerplate and tool output. Cover this failure with offline fixtures.
2. Make the current working directory explicit and distinguish historical absolute paths from
   actionable paths. Qualify shell read boundaries rather than relying on file-tool restrictions.
3. Make original task briefs and later submitted requirements unambiguous in source lookup.
   Successful continuation must not depend on a receiver guessing that an optional lookup is essential.
4. After offline fixes, predeclare a new paired trial budget. Add repetitions, realistic interruption
   points, and stronger workflow baselines before making product-wide claims.

All authorized launches for this experiment are complete. Another live trial needs a new budget.
