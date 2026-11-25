# Automatic continuity prototype

Alpha.5.5 includes this experimental, opt-in CLI feature. The alpha.5.1 downloads do not contain it.
See the [update notes](release-0.1.0-alpha.5.5.md) for installation and upgrade instructions.

## Use the CLI

Check that `relay --version` prints `0.1.0-alpha.5.5` or newer. To try it from source, build with
`npm ci` and `npm run build`, then use `node /path/to/rirei/dist/index.cjs` in place of `relay`.
On Windows, use `relay.cmd` if PowerShell blocks `relay.ps1`.

Inside an initialized project with an active Relay task:

```sh
relay context enable
relay run claude
# After the managed Claude run stops:
relay context status --json
relay handoff --json
relay switch codex
```

`switch` previews the handoff and asks before launch; `--yes` is the existing explicit
noninteractive approval. `run` is an explicit launch and can also include captured context.
Capture starts only in new managed Claude runs; existing sessions and transcript directories
are not scanned. Codex receives the handoff, but a native Codex capture adapter is not included.

Read-only retrieval:

```sh
relay context task
relay context task --after 10 --limit 10
relay context history --kind prompt_submission --limit 20
relay context history --after 20 --limit 20
relay context evidence e-0123456789abcdef0123456789abcdef
relay context evidence <event-id> --start 0 --length 2000
relay context find --file src/feed.mjs --kind tool_result
relay context read --file src/feed.mjs --start-line 20 --line-count 60 --snapshot <id>
relay context batch --request-file queries.json --snapshot <id>
relay context inspect --format text
relay context inspect --snapshot <covered-snapshot-id> --file src/feed.mjs
```

Use the actual event ID or `nextAfter` value returned by the preceding query. Lookups stay
within the current task and worktree. `task` returns the original task record, the exact current
workspace, and a `submittedMessages` page of retained submissions. Follow its `nextAfter` with
`--after` until null. Empty structured requirement fields do not imply that later submissions
contain no requirements. Disabling capture excludes these submissions from `task` output.

`relay context disable` revokes existing capture grants and excludes retained evidence from
automatic handoffs. `relay context clear` also removes this task's generated capture files,
including abandoned temporary records. Both operations require the operator; managed agents
cannot enable or change consent through these commands. Neither operation changes task state,
source files, other tasks, or token-analytics preferences.

## Storage and budget

Records live under `.relay/context/<task-hash>/`. Capture is independent of token analytics.
The journal uses hash-linked JSONL records, logically appended through fsynced atomic
publication. Tool IDs support replay deduplication; prompt hooks without stable IDs are kept
as separate submissions. Receipt order is not proof of semantic causality between parallel tools.

Limits: 256 KiB hook input, 16,000 characters per retained text field, 2,000 events / 4 MiB per
task journal, and a 6,000-character evidence postlude added to the existing handoff budget.
Character-based token estimates remain approximate. The preview reports the combined budget.
Complete submitted messages now take priority over tool output and assistant claims. If all
retained submissions fit, they stay whole in receipt order; otherwise newer complete messages
are selected first. Exact sentence/line excerpts are fallback previews only. Any submission
not fully inline produces a **required-before-editing** source-lookup instruction and explicit
`submissionCoverage.requiredSourceIds`; excerpts never establish requirement completeness.
Capture truncation/redaction remains distinct from display omission, and lookup cannot recover
text that was never retained. Character ranges continue to refer to exact retained source text.

The briefing identifies the current workspace. Historical path-bearing tool commands, outputs,
edit paths, and assistant claims are omitted from previews and replaced with source citations.
Their exact source records remain available. This display heuristic does not enforce shell or
filesystem isolation; explicitly submitted requirements are preserved rather than path-filtered.

The compact briefing groups repeated command results, distinguishes tool completion from
numeric command exits, and marks results that precede later reported file edits as unverified
for the current worktree. Pending commands remain unknown. Historical assistant statements
remain labeled claims. Capture-level truncation is separately reported; retrieval cannot recover
text that was never retained.

Known Rirei-generated launch prompts are retained as `launch_prompt` records but excluded from
the new-instruction stream to avoid recursively embedding previous handoffs. No model is used
to infer requirements or supersession. An assistant success statement remains an unverified
claim, and a tool hook without a numeric command exit code leaves that exit code unknown.

## Decision and scope

### E1 live quality smoke (2026-11-18)

The [current candidate versus frozen-control run](../benchmarks/continuity/reports/e1-2026-11-18.md)
used eight authorized fresh receivers on four saved checkpoints. Both versions passed 4/4 strict
cases and 28/28 acceptance groups, with complete traces and intact evidence. No reviewed quality
regression was observed. Efficiency was mixed, and no native context lookup was exercised.
Login-shell PATH shadowing means the explicit benchmark helper path needs separate qualification.
The budget is spent; E2/E3 remain separately budgeted, and no faster/cheaper default was promoted.

### Output/layout candidate preparation (M5)

`relay handoff --profile focused-output|stable-layout|stable-focused` previews named experimental
renderings. The default `control` keeps the current composition. Candidates preserve exact
selected instructions and uncertainty; any extra prompt text uses existing capsule headroom
and falls back explicitly to control if it cannot fit. Profiles are not new native launch options.

The offline policy benchmark replays all four saved cases and emits a balanced AB/BA proposed
schedule plus cache-counter analysis controls. Shared prefix bytes are diagnostics, not measured
cache reuse. No live sessions were used, and output/token/cache/continuation-time benefits remain
unmeasured for these profiles. See [M5 preparation notes](handoff-efficiency-m5.md). E1 used the
default composition; live output/layout ablation remains pending.

### Targeted retrieval (M4)

Bounded evidence/file windows now return exact retained or observed text, digests, provenance,
requested/actual ranges, and source-bound continuation cursors. `context find` indexes exact
reported fields without inferring file dependencies from commands. `context batch` handles up
to eight queries with explicit per-item results/errors/deferred states under one 12,000-character
envelope. Single responses default to 2,000 characters, with an 8,000 hard maximum.

Full retained evidence remains available with `--full`. Current-file windows require a snapshot
or expected content hash, and long lines resume without losing or duplicating Unicode text.
Changed sources, task/workspace, capture policy, or filters invalidate continuation. The
[M4 notes](handoff-efficiency-m4.md) document the 824-test qualification, preserved saved-case
requirements, and authored retrieval-volume comparison. No new live model sessions were used.

### Bounded current-state inspection (M3)

`relay context inspect` combines retained requirements, current file changes/source excerpts,
verification freshness, and explicitly recorded actions in one bounded response. Text is the
default; `--format json` returns the versioned envelope. The default 6,000-character ceiling
includes all serialized metadata and escaping, with a 12,000 hard maximum. `--snapshot` refuses
stale/incomplete identities, `--file` focuses optional code, and `--no-code` requests metadata only.

Whole retained instructions consume the budget first. Missing or truncated source is explicitly
incomplete and points to required paged retrieval or clarification. Enabled handoffs share their
covered identity with a compact on-demand inspection lookup within the existing evidence ceiling;
source windows are retrieved separately. See [M3 notes](handoff-efficiency-m3.md) for the 796-test
offline qualification, four saved-case requirement checks, and preparation measurements.

### Covered verification observations (M2)

The working-copy CLI now records host-observed configured-test receipts from `relay finish
--run-tests`. A pending receipt is persisted before launch, with completion binding the
observed exit to start/end covered-input and partial environment identities. Captured provider
tool reports and assistant claims remain separate; old records do not gain invented receipts.

Use `relay context verification` for bounded freshness summaries, or `--receipt <id>` to include
one retained receipt from the current task. Both are read-only, work after completion, and use
the existing managed-reader consent/capability checks. Other-worktree receipts cannot verify
the current workspace. Receipts live in task state and are preserved by capture disable/clear.

Matching covered boundaries are `current-observation`, with unmeasured environment and interval
inputs disclosed. The CLI creates no trusted deterministic reuse qualification and never
automatically skips tests. See [M2 milestone notes](handoff-efficiency-m2.md) for schemas, limits,
the 768-test offline qualification, and local snapshot-overhead samples.

### Continuation experiment

Test whether preserving submitted instructions and observed tool results reduces the work
needed to continue an interrupted task. The first integration is a managed Claude Code run
followed by an approved Codex launch. It uses the existing task, checkpoint, and lease paths.

Source-linked records establish what a provider reported, not that a diagnosis is true. User
prompt hooks may also carry generated prompts. Preserve their wording and chronology; do not
automatically promote them to verified human instructions or resolve ambiguous conflicts.

## Compatibility audit (2026-10-29)

Local executable inspection: Claude Code **2.1.258**, Codex CLI **0.153.4**, Node **22.14.0**.
Inspection used `--version`, `--help`, and Codex's local `features list` (`hooks`: stable,
enabled). Claude's `plugin validate --strict` accepted a temporary probe manifest containing
the proposed hook file. These checks establish metadata/configuration availability, not
delivery of hooks in a real provider session. No model inference was invoked.

| Evidence                    | Claude Code                                                                    | Codex                                                                  |
| --------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Submitted prompts           | Documented `UserPromptSubmit.prompt`                                           | Documented `UserPromptSubmit`; native adapter is a follow-up           |
| Tool requests               | `PreToolUse`, `tool_use_id`, `tool_name`, `tool_input`                         | Documented pre/post-tool events; schema/version qualification required |
| Tool results                | `PostToolUse.tool_response` or `PostToolUseFailure.error`; tool-specific shape | Documented `PostToolUse`; do not assume Claude result fields           |
| Assistant statements        | `Stop.last_assistant_message` where supplied; stored as claims                 | Transcript/app-server integration requires a separate adapter          |
| Session/workspace           | `session_id` and `cwd`, checked against the managed run                        | Existing app-server wrapper observes lifecycle only                    |
| Abrupt exit                 | No final hook guaranteed; retain only durable received events                  | Same limitation                                                        |
| Session-local configuration | Installed CLI advertises `--settings`                                          | Installed CLI advertises `--config`; hook trust must be respected      |

The Claude adapter uses documented fields and rejects mismatched sessions/workspaces.
Fixture replay and fake-provider execution qualify the recorder's offline behavior. The
[2026-11-02 two-way pilot](../benchmarks/continuity/reports/2026-11-02-bidirectional.md)
also exercised native Claude prompt/tool hooks and passive visible Codex exec capture with
real CLI predecessors. Full history passed all four paired cases; Rirei passed Claude → Codex
2/2 and failed Codex → Claude 0/2 because required details were omitted from its briefing.
The observer remains benchmark-scoped; general interactive Codex capture and native Windows
acceptance remain follow-ups. No transcript directories or credentials are scanned.

References: [Claude hooks](https://code.claude.com/docs/en/hooks),
[Codex hooks](https://learn.chatgpt.com/docs/hooks).

## Build versus reuse

[Qarinah's integration contract](https://github.com/AjnasNB/qarinah/blob/main/docs/HOST-INTEGRATIONS.md)
already describes Claude/Codex hooks, an evidence ledger, FTS retrieval, citations, and temporal
state. Its documentation is implementation evidence, not a controlled continuation result.

For the first experiment, implement a small project-local journal and lookup by record ID.
This lets the experiment isolate capture and context presentation without installing another
runtime or changing Rirei's task ownership. Keep the common source fields suitable for a later provider adapter so an
export/integration comparison can follow. A general graph, embeddings, and automatic semantic
supersession are not prerequisites for this experiment. Revisit reuse if retrieval beyond
record lookup becomes a measured bottleneck.

## Evidence contract

- Consent is explicit, scoped to the current Relay task, and independent of token analytics.
- A managed run receives a capture capability scoped to its task, provider, and working tree.
- Events carry receipt order/time, provider-session identity, source hook/tool IDs when exposed,
  a launch-time Git anchor, sanitized content, and explicit truncation/redaction flags.
- Tool completion does not mean tests passed. Record numeric exit codes only when supplied;
  otherwise the command exit is unknown. An assistant's success statement remains a claim.
- Submitted messages retain their chronology. A later correction and an earlier conflicting
  request remain inspectable rather than being silently merged.
- Missing starts/ends, pending tools, malformed tails, truncation, and unsupported coverage are
  reported. An absence of errors is never proof that every provider event was received.
- Compact prompts can link to complete retained records. Overflow is visible, and retrieval
  is read-only. Content addressing detects modification; it does not authenticate authorship.

## Six interruption fixtures

`benchmarks/continuity/fixtures.json` defines frozen repository files, provider event history,
reference implementations, and acceptance checks outside the successor workspace:

1. Repository-sufficient numeric clamp (negative control).
2. Late requirement to keep an existing API and avoid dependencies.
3. A rejected case-insensitive identifier lookup.
4. Failed validation followed by an edit without another test result.
5. A superseded inclusive/exclusive boundary instruction.
6. Abrupt interruption with an unfinished tool and incomplete history.

Their input hashes bind repository bytes and the available history. Gold expectations are
used only by the evaluator. Synthetic hook events establish recorder behavior, not native
provider compatibility or model-quality improvement.

Run `npm run benchmark:continuity` to check all six reference/interrupted pairs without a
provider. It prints frozen input hashes. The grader can evaluate a prepared candidate with
`node benchmarks/continuity/check.mjs --fixture <id> --workspace <candidate-directory>`.
The grader writes its acceptance driver outside that directory and executes the candidate
as a test; it is not a sandbox. Gold/reference data must be withheld from live successor
workspaces and exposed only after a run ends.

## Comparison contract

`npm run benchmark:handoff` now prepares a four-arm before/after engineering comparison
against the byte-frozen previous renderer, full history, and request-only. The separately
approved live path has a 12-session Codex budget; see
[Continuity evaluation](../benchmarks/continuity/README.md). It is a synthetic successor pilot,
not an executed five-arm or real cross-provider study.

The [2026-10-29 synthetic pilot](../benchmarks/continuity/reports/2026-10-29-pilot.md) completed
12 Codex sessions. Every arm passed 3/3 tasks. V2 used 11.54% fewer prompt characters and 5.50%
fewer total input tokens than V1, but 52.70% more non-cached input plus output; cache reuse
varied. This is not evidence of a correctness or cost win. The 12-session budget is spent.

The [2026-11-02 real-predecessor pilot](../benchmarks/continuity/reports/2026-11-02-bidirectional.md)
used four predecessors and eight receivers across both directions, plus an authorized replacement
for one failed authentication launch. Its correctness regression in Codex → Claude is a failed
quality gate for the briefing tested in that trial; smaller prompts do not justify accepting it.

The subsequent [requirement-preservation candidate](../benchmarks/continuity/reports/requirement-preservation-replay.md)
replays those saved histories without provider calls. It restores all six complete requirement
strings in all four previews, includes the current workspace, and suppresses the historical
predecessor paths. This is an offline source-preservation result, not a replacement live score.

The [receiver-only live retest](../benchmarks/continuity/reports/requirement-first-live-retest.md)
then reused the four checkpoints with eight fresh receivers. Rirei and full history each
passed acceptance on 4/4 cases. One Rirei session had storage/capture errors, leaving 3/4
strict successful runs; clean paired efficiency excludes that affected pair. This is positive
behavior evidence for the fix, with broader quality and efficiency still unproven.

Each successor receives an identical frozen repository and the same tool permissions/model
configuration. History-based arms can access the same permitted source history. Pin the exact
Orca release and preserve its prompt builder's output; do not replace it with a weaker prompt.
`benchmarks/continuity/protocol.json` pins Orca **v1.4.237** and prompt-builder Git blob
`41c5c72bd30fb8ec3ce41bbbb4ca62324182c060`. This is a source pin, not an executed Orca
baseline or completed model comparison. Agent-written handoff generation is also pending.

| Arm                      | Preparation required                                                        |
| ------------------------ | --------------------------------------------------------------------------- |
| Request + repository     | Exact initial request                                                       |
| Agent-written HANDOFF.md | Record generation timing, model, latency, and tokens; no oracle facts       |
| Orca focused             | Released implementation, actual accessible transcript, current status hints |
| Full transcript          | Exact authorized source history with truncation disclosed                   |
| Rirei automatic          | Captured records, compact preview, read-only source lookup                  |

Separate a **representation** comparison (same history available) from a **workflow** comparison
(capture setup, preparation, interruptions, and user repair). A handwritten fixture baseline
must never be reported as an agent-generated handoff. Model-assisted extraction is a later
ablation with its own measured costs.

Primary outcome: correct completion without a user repairing the successor's understanding.
Also record constraint violations, unsupported claims, justified versus redundant retries,
necessary versus unnecessary questions, useful-action latency, human minutes, and total
preparation/retrieval/continuation usage. Re-reading a file is not automatically wasted work.

Start with deterministic fixture checks. A proposed live pilot is six tasks × five arms =
30 successor runs, plus separately accounted preparation. Live execution needs an agreed
provider/model/call budget. Preserve failures and missing metrics. Use pilot variability to
size repetitions and the larger study; six tasks cannot establish broad superiority.

## Qualification and remaining work

Offline tests cover consent/revocation, workspace/session matching, replay, concurrent writes,
corruption detection, torn UTF-8 tails, bounded previews, source lookup, late corrections,
and unchanged launch guards. A fake-provider end-to-end test exercises both source and compiled
CLI launches, abrupt exit without a final summary, and an approved Codex successor.

Remaining gates: repeat requirement-preservation checks on additional held-out tasks, qualify complete native
Claude event coverage and Windows behavior, integrate native interactive Codex capture and
application switch acceptance, then run a separately budgeted broader baseline study. The
controlled two-way pilot does not qualify those interactive workflows. There is no new desktop/TUI
continuation dialog or semantic fact-extraction model in this milestone.

## Acceptance and decision

Offline gates: no invented result or instruction, resolvable source IDs, no silent mandatory
content loss, replay-safe writes, useful partial recovery, and unchanged launch ownership.

Advance to user trials only if paired live results show a meaningful reduction in total
continuation effort with acceptable correctness. If a handoff file or focused transcript
reference is equally effective with less overhead, ship the smaller mechanism. The papers
motivate the experiment; they do not demonstrate Rirei's advantage.

Selected primary sources: [Handoff Debt](https://aclanthology.org/2026.emnlp-main.738/),
[Compact-Bench](https://arxiv.org/abs/2610.31710v1),
[Lost in Context Compaction](https://arxiv.org/abs/2608.11242v2),
[The Complexity Trap](https://arxiv.org/abs/2508.21433v3).
