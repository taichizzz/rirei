# CLI reference

Task-oriented Relay commands run inside a Git repository. Device-level commands such as
`agents`, `doctor`, `usage`, `attach`, and daemon supervision can run from any directory. In
development, invoke commands with `npm run dev -- <command>`; once installed, use the `relay`
binary directly.

Commands that operate on a task (`note`, `checkpoint`, `handoff`, `message`, `session`, `run`, `switch`, `finish`) first
call `taskContext()`, which requires an existing task whose status is `active` or `blocked`.
If no task is active they exit with an error.

---

## `relay init`

Initialize Relay in the current repository.

- Discovers the repository root (`git rev-parse --show-toplevel`); errors if not in a repo.
- **Refuses to overwrite** an existing `.relay/` directory.
- Adds `/.relay/` to the repository-local Git exclude file (`git rev-parse
--path-format=absolute --git-path info/exclude`) so ordinary `git status` stays clean; aborts if exclusion cannot be
  installed. Existing exclude contents and modes are preserved, and the operation is
  idempotent.
- Creates `.relay/` (`0700`), plus `checkpoints/` and `test-output/` subdirectories.
- Writes a default `.relay/config.json` (see [configuration.md](configuration.md)).
- Prints guidance that generated logs/checkpoints/test output should be git-ignored, while
  human-authored task and decision files may be committed later.

Notes / current limitations:

- `init` does **not** probe for installed agent CLIs (use `relay doctor` for that).
- `task.md`, `decisions.md`, and `handoff.md` are **not** pre-created; they appear when first
  written. The sanitized activity snapshot lives outside the repository and is published from
  validated state mutations.

---

## `relay start "<task>"`

Begin a durable task.

**Argument:** the original task request (quoted).
**Option:** `--allow-dirty` — permit starting with uncommitted changes.

Behavior:

- Requires `.relay/config.json` to exist (otherwise: "Relay is not initialized").
- Refuses to start if an existing task is `active` or `blocked`.
- If the working tree is dirty and `--allow-dirty` is not passed, it errors and asks you to
  review the tree. With `--allow-dirty`, `dirtyAtStart: true` is recorded and a warning is
  printed.
- Records: a `sessionId` (`crypto.randomUUID()`), the task title (first line of the
  request), the starting commit and branch, and empty arrays for requirements, constraints,
  decisions, completed/remaining work, tests, checkpoints, blockers, and handoff notes.
- Appends a `task_started` event.

---

## `relay status`

Print the current task status. Reads state plus a live Git baseline. Does **not** require an
active task (it will surface a completed/cancelled task too).

**Option:** `--json` — print the structured status used by Rirei's task dashboard, including
live Git dirtiness/changed-file count; the full remaining-work, decision, and blocker lists;
and the complete `agentHistory` array used by the session timeline. History stays in launch
order (oldest first) and includes the provider, optional model/effort overrides, timestamps,
exit code, and classified exit reason. Rirei reverses this array for newest-first display.

Displayed fields: session ID, task title, status, current agent, previous agents, starting
commit, current commit (live), current branch (live), changed-file count, whether the baseline was dirty, latest
test result, latest checkpoint id, and counts of completed items, remaining items,
decisions, and blockers.

The human-readable status continues to summarize current and previous agents. Detailed
per-run history is intentionally confined to `--json` so the default terminal output remains
compact. If the most recent run ended at a usage limit or rate limit, `relay status` prints a
suggested alternative provider and switch command; in `--json` mode, an optional `handoffOffer`
structure is included detailing candidate targets, reasons, and continuation note warnings.

---

## `relay agents`

Show installed adapters, CLI versions, discovered models, and supported effort levels.

**Option:** `--json` — print the machine-readable catalog used by Rirei's session-profile
picker. Codex models come from `codex debug models`; Antigravity uses a catalog verified from
`agy models`; OpenCode reads live `provider/model` lines from `opencode models`; Claude uses
documented model aliases and effort values. Discovery failures return an empty
values list with an explicit unavailable/unsupported/error discovery status rather than silently
pretending an available catalog is empty. See the typed adapter contract in [agents.md](agents.md).

---

## `relay note <type> <text>`

Record a short, structured handoff fact. Types are `done`, `next`, `decision`, `rejected`,
`blocker`, and `question`. `relay note resolve <id>` closes a note so future handoffs omit it.

**Options:** `--reason <text>` adds a concise rationale or failure reason. `--source user|agent`
declares who supplied the statement; agent reports also require `--agent <name>`. `--json`
returns the complete stored record.

Every note stores a Git commit, branch, and snapshot fingerprint. A handoff labels the note
`changed` or `diverged` when the receiving working tree no longer matches that anchor. This is
a freshness warning, not proof that the statement is false. Notes are stored locally under
`.relay/`, but unresolved notes selected for a handoff are sent to the receiving provider.
Do not record secrets. A task accepts at most 500 notes rather than silently discarding history.

## `relay note import --stdin`

Atomically import a machine-oriented batch of notes from a JSON payload on standard input.
Intended for agents that finish a work phase and must hand off several facts reliably.

**Options:** `--source user|agent` and `--agent <name>` follow the single-note rules; provenance
always comes from these CLI options, never from the payload.

Payload schema:

```json
{
  "schemaVersion": 1,
  "notes": [
    {
      "type": "next",
      "text": "Implement IMF-fixdate parsing and clamp past dates."
    },
    {
      "type": "rejected",
      "text": "Do not use parseInt.",
      "reason": "It accepts malformed numeric prefixes."
    }
  ]
}
```

The payload is capped at 16 KiB and 20 notes. Every item is validated before any state is
written; one invalid item rejects the entire batch. The whole batch shares one Git snapshot and
one write transaction, and a changed task/session aborts the import. Unsupported note types
fail with the canonical type list and guidance that unfinished work belongs in `next` and
finished work belongs in `done`; ambiguous values are never silently remapped. Unknown top-level
or note fields are rejected. In particular, payload-supplied provenance is invalid rather than
trusted or silently retained.

---

## `relay checkpoint`

Capture the current working-tree state without modifying the repository.

**Option:** `-m, --message <label>` — a short label stored in the checkpoint metadata.

Creates `.relay/checkpoints/<id>/` containing `metadata.json`, `status.txt`,
`diff-stat.txt`, and a size-bounded `changes.patch`. Updates the recorded current
commit/branch, prunes old checkpoints beyond `checkpoint.maxCount`, and appends a
`checkpoint_created` event. See [checkpoints-and-handoff.md](checkpoints-and-handoff.md).

---

## `relay handoff`

Print a concise, provider-independent handoff to **stdout**.

The default handoff is a compact continuation prompt: one `Task:` line, a short Git anchor
(`Git: main@<7-char commit>; dirty` when the working tree has changes), and the safety line
`Inspect the working tree and preserve existing changes.` Unresolved notes are added newest
first in priority order: `next`, `blocker`, `rejected`, `decision`, `question`, then the latest
verification observation in M2 (a failed-test fallback for older
capsules). Lower-priority items are omitted rather than truncated into fragments, and an
`Omitted:` count is added when it fits. The rendered text is capped at the lower of
`handoff.maxCharacters` and the effective `handoff.maxTokens` target (defaults: 1,200
characters and 300 estimated tokens); the reported `estimatedTokens` is a deterministic
provider-neutral estimate (`characters / 4`), never an exact provider count. The raw diff,
`done` notes, full test records, and changed-file lists stay in the structured capsule. A
verification line can include a reported zero exit with its freshness/qualification label.

**Option:** `--json` — print the versioned portable capsule, rendered text, freshness labels,
budget/omission metadata, and content checks (task-occurrence count and note-instruction
detection).

**Experimental rendering option:** `--profile control|focused-output|stable-layout|stable-focused`.
`control` is the default. Focused output adds a short provider-neutral receiver policy; stable
layout reorders already-selected content with current workspace authority early and runtime
warnings grouped at the end. Neither policy removes requirements/citations/uncertainty to fit.
Additional characters use existing legacy-capsule headroom; insufficient space retains control
text and reports the fallback on stderr or in JSON `policy` metadata.

Profiles apply to `handoff` previews and offline candidate preparation, not `run`/`switch` launch
options. They do not persist configuration or enable provider cache controls. In reordered JSON,
`text` is the composed candidate; `continuity.text` remains the control-selected evidence audit
view. See [M5 notes](handoff-efficiency-m5.md) for profile, budget, and evaluation contracts.

> Current limitation: `handoff` prints to stdout only; it does not write `.relay/handoff.md`.

---

## `relay context` (experimental)

Opt-in, task-local continuation evidence for new managed Claude runs. Requires an initialized
project and a Relay task. This is separate from token analytics and does not scan transcripts.

```sh
relay context enable
relay context status --json
relay context task
relay context task --after 10 --limit 10
relay context history --kind prompt_submission --limit 20
relay context history --after 20 --limit 20
relay context evidence <event-id>
relay context evidence <event-id> --start 0 --length 2000
relay context evidence <event-id> --full
relay context find --file src/feed.mjs --kind tool_result --limit 5
relay context read --file src/feed.mjs --start-line 20 --line-count 60 --snapshot <id>
relay context batch --request-file queries.json --snapshot <id>
relay context verification
relay context verification --receipt <receipt-uuid>
relay context inspect --format text
relay context inspect --snapshot <covered-snapshot-id> --format json
relay context inspect --file src/feed.mjs --max-characters 6000
relay context disable
relay context clear
```

- `enable`: retain bounded, redacted submitted prompts and visible hook/tool results for the
  current task. Only the operator can change consent or clear records through the CLI.
- `status`: report capture policy, retained workspace event count, and known coverage gaps.
- `task`: read the original task record, current workspace, and retained submitted messages.
  Follow `submittedMessages.nextAfter` using `--after` until null; `--limit` accepts 1–20.
  Empty task requirement fields do not imply there are no later submitted instructions.
  Submitted messages are excluded while capture/disclosure is disabled.
- `history`: read up to 20 historical events per page, optionally filtered by kind; follow
  `nextAfter` using `--after`. Managed readers need capture/disclosure enabled.
- `evidence`: retrieve a cited record in the current task and worktree. No options, or `--full`,
  returns the legacy full retained record. `--start`, `--length`, `--cursor`, `--format`, or
  `--max-characters` selects the bounded schema-v1 window response; `--full` cannot be mixed
  with window options. Offsets are zero-based UTF-16 units in retained sanitized text, with
  explicit surrogate-boundary adjustments and separate capture/page truncation flags.
- `find`: bounded historical references filtered by exact `--file`, `--kind`, `--tool-id`, or
  derived `--command-id`. `--limit` accepts 1–20, default 5. A command ID groups reported tool
  evidence within a provider/run; file dependencies are never inferred from shell text.
- `read`: an exact current-file window from consistent covered scans. Requires relative `--file`
  and a matching complete `--snapshot` or matching `--content-hash`. The hash-only option covers
  that file, not the whole environment/worktree. `--start-line` is one-based (default 1), and
  `--line-count` accepts 1–1,000 (default 60). Long lines can continue at an explicit column offset.
  Missing, ignored, sensitive, linked, binary, invalid-UTF-8, oversized, or unstable sources fail
  clearly; recognized-secret source text is withheld rather than silently altered.
- `batch`: one to eight schema-v1 queries from a regular relative `--request-file` of at most
  32 KiB. Every query has an `ok`, `error`, `deferred`, or `done` status. `--snapshot` supplies a
  default read anchor. Create a covered request file before taking its snapshot, and keep
  continuation cursors on the command line rather than changing the request file. A generated
  batch can contain per-item errors; callers must inspect statuses. See the [request schema and
  example](handoff-efficiency-m4.md#batch-requests).
- `inspect`: one read-only current-state packet containing retained requirements, staged/worktree
  file states and code excerpts, verification freshness, and explicitly recorded next/blocker items.
  `--format text|json` defaults to text. `--max-characters` accepts 1,200–12,000, default 6,000,
  and bounds the complete serialized response, including escaping, metadata, and final newline.
  `--snapshot` requires the same complete current covered-input identity; stale/partial identities
  fail clearly. `--file` focuses optional source context on one relative path, while `--no-code`
  returns metadata/instructions only. Managed readers need disclosure consent; operators can
  also inspect closed tasks. No query telemetry or persistent source cache is written.
- `verification`: inspect up to 64 host-command/legacy verification summaries and current covered
  input/environment identities when relevant. `--receipt` includes one retained current-task
  receipt. Output is JSON and always reports `automaticTestReuse: false`; no tests are run.
  Managed readers need the existing disclosure consent. Another-worktree receipt cannot verify
  the current workspace. Lookup also works after task completion.
- `disable`: revoke grants and exclude retained evidence from automatic handoffs.
- `clear`: disable capture and remove current-task generated evidence, preserving task state
  (including verification receipts) and other tasks.
- `ingest`: internal bounded-stdin receiver; requires a managed capture grant and active run.

Enabled handoffs append up to 6,000 characters of evidence beyond the existing compact
handoff budget. The combined budget and omissions are reported. Generated launch prompts
are distinguished from later submissions; tool success does not prove tests passed.
Captured evidence can satisfy the switch's continuation-context gate without manual notes,
while preview approval and stale-context/working-tree checks remain in force.
Complete submitted messages take priority over tool logs. `submissionCoverage` identifies
messages not fully inline; the prompt requires source lookup before editing when any are
missing. Historical path-bearing tool/assistant text is cited rather than repeated in previews,
and retrieval reports the current workspace alongside exact retained records.

M3 handoffs also include a snapshot-bound inspection lookup when it fits after submitted text.
Source excerpts remain on demand. `inspect` selects whole retained requirements first and reports
`lookup-required` or `source-incomplete` when appropriate. Follow the required task pagination
before editing; optional code never establishes requirement completeness. Display diffs can be
truncated/redacted, with explicit binary, missing, sensitive, and size/coverage omissions. See
[M3 notes](handoff-efficiency-m3.md) for bounds, schema, caching, and offline results.

Bounded `evidence`, `find`, and `read` responses default to a **2,000-character complete
envelope**, adjustable with `--max-characters` from 1,200 to **8,000**. `batch` uses 12,000 by
default and accepts 2,400–12,000. All include final serialization, metadata, and cursors in the
budget. `find`/`read` default to text; bounded evidence and batch default to JSON. `--format`
selects either representation.

`--length` and `--line-count` are per-page limits. To continue, repeat the same source query,
filters, and ranges with `--cursor`; format and output budget may change. Changed task state,
workspace, consent, history, or selected source makes the cursor stale. Batch returns an aggregate
cursor plus per-result cursors, and deferred queries receive later turns. A null cursor means
the retained/observed source is exhausted, not that uncaptured context is complete. Read-only
queries revalidate their sources and write no persistent index or query telemetry. See
[M4 notes](handoff-efficiency-m4.md) for the full contract and qualification.

Verification freshness is `historical`, `pending`, `stale`, or `current-observation` in the
current CLI. Matching covered files leave the environment unqualified. `reuse-eligible` is
reserved for an explicit trusted deterministic host qualification; the CLI creates no such
qualification and never automatically skips tests. See [M2 notes](handoff-efficiency-m2.md).

See [Automatic continuity prototype](continuity-prototype.md) for qualification limits and
the evaluation history. Native interactive Codex capture remains a follow-up; Codex can receive
the generated handoff.

---

## `relay run <agent>`

Launch an installed official CLI (`claude`, `codex`, `gemini`, `antigravity`, or `opencode`)
for the current task.

**Option:** `--prompt <prompt>` — use an explicit prompt instead of the generated handoff.

**Options:** `--model <model>` and `--effort <level>` — apply provider-specific session
overrides without changing global provider configuration. Unsupported effort values fail
before launch.

**Host options:** `--operation-id <id>` supplies an idempotency key, and `--terminal-id <id>`
records the terminal that owns the run. Frontends should generate these; ordinary interactive
CLI use can omit both.

**Option:** `--fail-on-exhausted` — refuse to launch if the provider's fresh telemetry reports an exhausted quota. By default, interactive runs prompt for confirmation before proceeding, while non-interactive runs log a warning.

Behavior:

- Validates the agent id.
- Builds the prompt (the handoff by default, or `--prompt`).
- Checks pre-flight quota status if the provider supports `readUsage`. If exhausted and `--fail-on-exhausted` is set, launch aborts. In an interactive terminal, prompts for confirmation.
- `launchAgent()` verifies the executable is installed, records `agent_started`, spawns the
  CLI with **inherited stdio** in the repository root, classifies the exit, and records
  `agent_ended`. Relay's exit code mirrors the agent's non-zero exit code.
- If the agent exits with a usage limit or rate limit, Relay prints a handoff suggestion with available alternative providers and the corresponding `relay switch <agent>` command.

The launched CLI handles its own authentication. Relay passes the prompt and any explicit
model/effort selection.

---

## `relay switch <agent>`

Checkpoint, preview a handoff, then launch another agent.

**Options:** `--model <model>`, `--effort <level>`, `--operation-id <id>`, and
`--terminal-id <id>` use the same session controls as `relay run` for the incoming agent.
`--yes` is required for non-interactive launches and skips confirmation after the caller has
reviewed the generated preview. `--allow-empty-notes` overrides the continuation gate and
launches even when no unresolved continuation note exists. `--fail-on-exhausted` refuses to
launch if the incoming provider reports an exhausted quota.

Sequence:

1. Validate the agent id and load the active task.
2. `createCheckpoint()` with the label `Switch to <agent>`.
3. Render from the checkpoint's exact Git snapshot and print the handoff plus estimated budget.
4. If no unresolved `next`, `blocker`, `rejected`, `decision`, or `question` note exists, the
   preview warns that the handoff contains only Git-recoverable context; non-interactive
   launches fail at this point unless `--allow-empty-notes` is given.
5. In an interactive terminal, ask the user to approve the launch unless `--yes` was supplied
   (with the `(no continuation notes recorded)` suffix when the gate is the only concern).
6. Recheck state and Git after approval; if either changed, refuse the stale preview.
7. `launchAgent()` for the target CLI (records `agent_started` / `agent_ended`). A cancellation
   or refusal keeps the checkpoint but launches nothing.
8. If the run exits at a usage or rate limit, Relay suggests alternative providers and commands.

The CLI also rechecks an approved complete covered-input identity
after provider setup, immediately before launch. A changed or unavailable identity requires a
fresh preview; a storage-only revision does not. Legacy Git fingerprint semantics are unchanged.

> Current limitation: `switch` records agent start/end events but does not append a distinct
> `switch` event.

---

## `relay workspace`

Manage isolated Git worktree workspaces so several agents can work in one repository without
sharing a working tree. See [worktrees.md](worktrees.md) and the Git-safety section of
[security.md](security.md).

### `relay workspace create`

Create a workspace: a new branch `rirei/<slug>-<role>-<id>` and a linked worktree stored under
the Rirei data home. **This is the only Git-mutating Relay command** (`git worktree add -b`).
It never touches the main working tree.

**Options:** `--role <implement|review|verify|investigate>` (default `implement`),
`--slug <slug>` (defaults to the task title), `--json`.

Launch an agent inside the workspace with `relay run <agent> --workspace <id>`. Because each
workspace is a separate working tree, several agents can run concurrently — Relay allows at most
one writing run per working tree.

### `relay workspace list`

List the workspaces registered for this repository (`--json` for machine-readable output).

### `relay workspace cleanup <workspaceId>`

Inspect a workspace for safe cleanup and print copyable `git worktree remove` / `git branch -d`
commands. **Relay removes nothing** — it reports the active run holding the workspace,
dirty/untracked files, commits ahead of base, and unpushed commits, and marks cleanup blocked
when removal would lose work. `--json` for machine-readable output.

---

## `relay resume <agent>`

Resume a provider-owned Claude, Codex, or OpenCode conversation in a new interactive PTY. Use
at most one of `--picker`, `--latest`, or `--id <value>`. Providers with a picker default to it;
OpenCode defaults to latest because its CLI exposes no picker. Claude and OpenCode support
`--fork`. An optional `--prompt`, `--model`, or supported `--effort` applies to the resumed launch. Relay
records resume metadata but does not read provider conversation files. Frontends can also pass
`--operation-id` and `--terminal-id`.

## `relay history [query]`

Search the current task and archived project task metadata. `--json` returns task, run,
provider, model, effort, result, and checkpoint metadata. Before a completed/cancelled task is
replaced, its state is archived under `.relay/tasks/<session-id>/state.json`.

## `relay recover --force`

Mark a recorded current run as interrupted and clear its active lock. Relay cannot prove that
an external provider process has stopped, so explicit `--force` confirmation is required.
Use `--run-id <id>` when several orphaned runs exist and `--reason <text>` to record why
recovery is safe. Recovery events include the requester and reason.

## `relay reconcile`

Check durable controller and bridge ownership without releasing any worktree. `--json` returns
`live`, `needs_attention`, or `orphaned` per run. Different-boot or unverifiable ownership
remains blocked; only a conclusively missing same-boot local PID is marked orphaned.

## `relay checkpoints` / `relay checkpoint-diff <id>`

List retained checkpoints or read the selected checkpoint's saved bounded patch. Both support
`--json`. The reader validates IDs and artifact paths, rejects symlinks, omits binary patch
bodies, and never changes Git state.

---

## `relay usage`

Show how much each registered agent has been used during the current task.

**Options:** `--json` prints the machine-readable task/plan summary. `--plans-only` reads provider
plan telemetry without requiring a Git task, including for background polling. This does not
invoke the separate token-history scanner or opt into analytics.

The task-use section derives run counts/duration summaries, last-run time and last exit reason
from Relay's own `agentHistory`. Agents never run on that task have zero task runs. The separate
plan section reads the supported numeric quota sources described below; neither section is a
machine-wide model-token/cost measurement or a credential-file read.

`--json` additionally includes a `plans` array with provider plan usage where a
machine-readable source exists: Claude (sanitized `rate_limits` captured from Claude Code's
status line into `~/.relay/provider-usage/claude.json`) and Codex (numeric `rate_limits`
fields parsed from bounded tails of recent local Codex session logs). Providers without a verified source
report `status: "unknown"` instead of a guess. Captured values become `stale` after 15 minutes
or after their reset time passes. No credentials are read; Codex rollout files are scanned
locally for numeric rate-limit events only.

### `relay usage tokens`

Show machine-wide token analytics across all coding agents on this computer, powered by a pinned `ccusage` integration.

**Options:**

- `--json` — Output structured `TokenUsageReport` JSON schema.
- `--days <number>` — Number of days to report (`7`, `30`, `90`; default: `30`).
- `--agent <id>` — Limit refresh to a specific agent (`claude`, `codex`, `gemini`, `antigravity`, `opencode`).
- `--opt-in` — Explicitly enable machine-wide token usage collection from local agent logs.
- `--opt-out` — Disable machine-wide token usage analytics.
- `--check-opt-in` — Check whether token usage analytics is currently enabled.
- `--refresh` — Bypass the cache and rescan local agent logs immediately.

Behavior and guarantees:

- Rirei requests offline/no-cost numeric reports from its install-owned native `ccusage` binary,
  normalizes them and privacy-validates the retained fields. The scanner has provider-log access;
  these flags are not OS-enforced network isolation or proof that raw log fields never enter
  that dependency's memory. See [the security boundary](security.md#token-analytics-and-quota-isolation).
- Project labels are sanitized across CLI/IPC boundaries: usernames/full paths are purged or
  hashed; a permitted project basename can still be shown as a label.
- Results are cached in `rireiDataHome()/token-usage-cache.json` with 180-day history per agent, file-lock-based single-flight deduplication, and instant range derivation (7D/30D/90D) without rescanning.
- Coverage is judged against the selected range. An agent is `(Partial)` only when its logs start after the range begins, `No activity found` when it has no logs in the 180-day window, and `[data through YYYY-MM-DD]` when the last scan predates today. Days after that date were not collected and are not counted as zero.
- JSON reports include `coverage.complete`, `coverage.dataThrough`, and `coverage.noActivity` per agent, a report-level `dataThrough`, `unitemizedTokens` (the part of a total its components don't account for; within a 1% gap the components are still shown), `sessionsUntimed` (sessions logged without times, such as OpenCode's), and a 13-week `calendar` used by the activity heatmap.
- Models and sessions are limited to the selected range. An available agent with `sessions: null` had its session scan fail; that is unknown, not zero.
- Each available agent carries `previous.tokens` (the preceding equal-length window) and `previous.shortHistory`, and `comparison` carries `previousSince`/`previousUntil`, so a filtered view can compare only the agents it shows.
- ccusage output missing a canonical `totalTokens` (per day, per model entry, per session, or in `totals`) is rejected as `invalid_output` rather than read as zero. A missing component stays unknown and falls into the unitemized remainder.
- The ccusage binary is resolved next to the running CLI, so the command works from any directory; it is never taken from the working directory.
- Failures print fixed messages with no paths or usernames. A refresh that finds another scan of the same agent running waits for it instead of failing.

---

## `relay finish`

Create a final checkpoint and mark the task completed.

**Option:** `--run-tests` — run the configured test command before completing.

Behavior:

- With `--run-tests`: requires `tests.command` in config; runs it via a shell with inherited
  stdio; records a `TestResult` (`passed`/`failed`, exit code, duration). If tests fail,
  Relay records the result and then errors without completing the task.
- A durable pending receipt is saved before launch and
  completed with observed exit, start/end covered-input/environment identities, and monotonic
  command duration. Spawn errors or signal exits leave interrupted/unknown evidence and block
  task completion; an unrecorded completion remains pending after a controller crash. Output
  remains `not-captured`. Receipts never authorize automatic test skipping.
- Creates a final checkpoint labeled `Final`.
- Sets task status to `completed`, clears the current agent, and appends a `task_completed`
  event.
- **Never** commits, pushes, or merges.

---

## `relay message`

Read and write durable, task-scoped coordination threads. Messages use the primary worktree's
`.relay/threads/` authority even when a managed run invokes Relay from a linked worktree.

Routing accepts only `operator` and canonical `run:<id>` references. Display labels are never
routing keys. `relay message peers` prints the active canonical references.

Commands:

- `peers [--json]`: list active peers and presentation labels.
- `preview --to <actor> (--text <body> | --stdin) [--redact]`: render the exact bounded,
  terminal-safe envelope and token estimate without persisting it.
- `send --to <actor> (--text <body> | --stdin) [--intent request|inform]
[--context-note <id>] [--context-checkpoint <id>] [--operation-id <uuid>] [--redact]
[--json]`: start a thread.
- `inbox [--unread] [--peek] [--json]`: read messages addressed to the caller. Without `--peek`,
  returned unread messages are atomically marked read.
- `threads [--filter <text>] [--json]`: list authorized current-task thread summaries.
- `thread <thread-id> [--json]`: show one authorized thread without changing receipts.
- `reply <message-id> (--text <body> | --stdin) [--intent request|inform|ack]
[--operation-id <uuid>] [--redact] [--json]`: reply to the other participant.
- `read <message-id> [--json]`: mark a message read as its recipient.
- `acknowledge <message-id> [--json]`: idempotently acknowledge a non-expired message as its
  recipient.

Exactly one body source is required. Body input is bounded to 8 KiB of strict UTF-8 while being
read. Up to three context cards may total 16 KiB; the complete envelope is limited to 32 KiB.
Each task is limited to 100 threads, 1,000 messages, and a 5 MiB journal.

All current adapters support `inbox` delivery only. `next_safe_turn` and `wake` requests fail
unless a future adapter advertises a verified official integration; Relay never silently falls
back. See [relay-threads.md](relay-threads.md) for storage and security details.

`preview`, `send`, and `reply` accept `--delivery <mode>` with default `inbox`. The schema also
recognizes `next_safe_turn`/`wake`, but capability checks reject them for current adapters; naming
a reserved mode does not inject a message into a provider or synthesize terminal input.

---

## `relay session label`

```sh
relay session label run:<id> "Display label" [--json]
```

Rename the presentation label for an active or historical run in the current task. Only a local
operator invocation may rename labels. Labels may be duplicated because they never route
messages.

---

## `relay doctor`

Inspect local prerequisites. Does not require a task.

`relay doctor --installation [--json]` checks only the installed CLI version, Node.js,
Git discovery, native PTY module, and pinned ccusage executable. It returns a nonzero exit
status if a dependency is unavailable. It does not read project state, scan agent logs,
or probe provider authentication. This is the installer diagnostic path.

Reports:

- **Git**: `ready` if in a repository, otherwise an error note.
- **Node.js**: the running `process.version`.
- **Relay**: whether `.relay/` is writable / initialized.
- A per-agent table: `Installed` (from a `PATH` scan for an executable file), and
  `Authentication` from the bounded official provider status interface where available.
- Advertised `Interactive` and `Headless` capabilities printed as Yes/No.

These are capability declarations and conservative auth observations, not live model/native
terminal acceptance tests. Authentication can be authenticated/configured/not_authenticated or
unknown/unsupported/error according to the provider source. Headless builders remain unimplemented
in current adapters even where an upstream provider has a separate headless command. The normal
doctor also inspects local data-directory/rollout availability; `--installation` is the separate
no-agent-scan package diagnostic. See [agents.md](agents.md).

---

## `relay tui`

Launch the cross-platform interactive terminal dashboard in Windows Terminal or any ANSI terminal.

```powershell
relay tui
relay tui "C:\Projects\my-app"
```

`relay tui [project]` requires an interactive terminal. On a project without an active task,
it guides explicit initialization and task start before the dashboard. It preserves existing
settings and tasks and requires acknowledgement of a dirty starting tree. Provider setup
links are shown; providers are installed and signed in separately. See
[Windows installation](windows-install.md).

Features:

- Responsive active-session list with git branches, runtime accounting, and attention badges.
- Detached-first launches that keep the dashboard visible and print a portable `relay attach <id>` command.
- Provider-aware model/effort launch profiles, including custom model IDs.
- Automatic isolated Git worktree creation when a new agent would conflict with a session already
  using the main working tree.
- A clickable mouse interface with keyboard fallback and bounded 80×24 rendering.
- Relay Threads unread attention, list/detail filtering, inbox-only composition and replies,
  context cards, read/ack actions, and receipt state.
- Remaining provider plan capacity with stale/error/unsupported states and exact UTC capture/reset
  timestamps.
- Hotkeys:
  - `c`: Launch Claude session
  - `o`: Launch Codex session
  - `g`: Launch Gemini session
  - `a`: Launch Antigravity session
  - `p`: Launch OpenCode session
  - `s`: Open new shell terminal
  - `Enter`: Attach to selected session (raw passthrough mode; press `Ctrl+Q` to return to the
    dashboard; `Ctrl+B`, then `D`, and `Ctrl+]` are fallbacks)
  - `x`: Confirm stopping the selected session
  - `Shift+x`: Confirm stopping every active terminal on the device
  - `u`: Open provider usage details
  - `m`: Open Relay Threads; use `n` to compose, `/` to filter, `i` for unread-only, and
    `m`/`a` in thread detail to mark read or acknowledge
  - `r`: Refresh dashboard state and provider model catalogs
  - `q`: Quit dashboard (leaves daemon and agents running)

---

## `relay attach <terminal-id>`

Attach the current interactive terminal to a session already owned by the detached daemon.

```bash
relay attach <terminal-id> [--read-only | --takeover]
```

- Can run from any directory, requires interactive stdin and stdout, and never starts a daemon as
  a side effect.
- Replays retained output before forwarding live terminal bytes.
- `--read-only` observes output without acquiring write or resize control.
- `--takeover` explicitly displaces the current writer; the displaced client is notified and detached.
- `--read-only` and `--takeover` cannot be combined.
- `Ctrl+Q` detaches. `Ctrl+B`, then `D`, and `Ctrl+]` remain fallback detach sequences.
- Finalized sessions replay all retained output and return without entering raw input mode.

---

## `relay bridge` (internal)

Internal CLI/state boundary used by the detached daemon. It does not run a provider command
or approve a tool request. One-shot modes require a Git repository and `--terminal-id <id>`:

- Registration: `--instance-id <id>`, `--pid <pid>`, and `--protocol-version <version>` record
  a matching active terminal-owned run's bridge identity.
- Observation: `--status <status>` records a normalized terminal observation, with optional
  `--lifecycle-state`, `--attention-kind`, `--active-runtime-seconds`, and `--runtime-sequence`.
  Stale runtime sequences and invalid status/lifecycle combinations are not accepted as newer work.
- Daemon adoption supplies the complete identity tuple `--daemon-id`, `--daemon-pid`, and
  `--daemon-boot-id`; partial tuples fail validation.
- Final outcomes can supply `--exit-code`, `--exit-reason`, `--exit-confidence`, `--exit-source`,
  `--provider-code`, and `--retry-at`. Validated finalization merges by terminal/run identity and
  releases the lease; missing data remains conservatively qualified.

`relay bridge --worker` instead keeps one process alive, reading bounded newline-delimited
version-1 JSON from stdin. Each request supplies its project, terminal ID, correlation ID, and
`register`/`update` type. Replies use `{v:1,id,ok}` with an error field on failure. The client
bounds frames to 128 KiB, pending requests to 64, and request duration to five seconds. Worker
request fields do not activate arbitrary command execution. See
[runtime synchronization](runtime-protocols.md#7-lifecycle-active-runtime-and-state-synchronization).

---

## `relay daemon`

Internal command used by the TUI and Electron application to launch and supervise the detached terminal daemon.

```bash
relay daemon --internal --socket <socket-path-or-named-pipe> --descriptor <descriptor-path>
```

Options:

- `--internal`: Runs the terminal daemon process in the foreground.
- `--ensure`: Explicitly start/reuse a compatible detached CLI daemon through the platform manager.
- `--socket <path>`: Path to Unix socket (`.sock`) or Windows named pipe (`\\.\pipe\...`).
- `--descriptor <path>`: Path to daemon descriptor JSON file.
- `--cli <path>`: Path to Relay CLI bundle.
- `--node <path>`: Path to Node.js executable.
- `--bridge <path>`: Legacy Python bridge location; merely supplying it does not activate the
  internally forced Python compatibility branch of the current daemon server.

---

## Exit codes

- Commands throw on error; the top-level handler in `src/index.ts` normally prints
  `relay: <message>` to stderr and sets `process.exitCode = 1`. If argv contains `--json`, it
  emits a versioned JSON error object instead. `--format json` on bounded retrieval selects
  its success representation but does not itself switch the global error handler.
- `run` and `switch` propagate the launched agent's non-zero exit code.
- A generated retrieval batch can return process success while individual queries have error
  statuses. Callers must inspect every item; one process exit is not a universal success claim.
