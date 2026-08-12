# CLI reference

Every Relay command must run inside a Git repository. In development, invoke commands with
`npm run dev -- <command>`; once installed, use the `relay` binary directly.

Commands that operate on a task (`note`, `checkpoint`, `handoff`, `run`, `switch`, `finish`) first
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
compact.

---

## `relay agents`

Show installed adapters, CLI versions, discovered models, and supported effort levels.

**Option:** `--json` — print the machine-readable catalog used by Rirei's session-profile
picker. Codex models come from `codex debug models`; Antigravity uses a catalog verified from
`agy models`; Claude uses documented model aliases and effort values. Discovery failures return an empty
model list rather than guessing.

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
failed test. Lower-priority items are omitted rather than truncated into fragments, and an
`Omitted:` count is added when it fits. The rendered text is capped at the lower of
`handoff.maxCharacters` and the effective `handoff.maxTokens` target (defaults: 1,200
characters and 300 estimated tokens); the reported `estimatedTokens` is a deterministic
provider-neutral estimate (`characters / 4`), never an exact provider count. The raw diff,
`done` notes, passed tests, and changed-file lists stay in the structured capsule and are not
sent to providers.

**Option:** `--json` — print the versioned portable capsule, rendered text, freshness labels,
budget/omission metadata, and content checks (task-occurrence count and note-instruction
detection).

> Current limitation: `handoff` prints to stdout only; it does not write `.relay/handoff.md`.

---

## `relay run <agent>`

Launch an installed official CLI (`claude`, `codex`, `gemini`, or `antigravity`) for the current task.

**Option:** `--prompt <prompt>` — use an explicit prompt instead of the generated handoff.

**Options:** `--model <model>` and `--effort <level>` — apply provider-specific session
overrides without changing global provider configuration. Unsupported effort values fail
before launch.

**Host options:** `--operation-id <id>` supplies an idempotency key, and `--terminal-id <id>`
records the terminal that owns the run. Frontends should generate these; ordinary interactive
CLI use can omit both.

Behavior:

- Validates the agent id.
- Builds the prompt (the handoff by default, or `--prompt`).
- `launchAgent()` verifies the executable is installed, records `agent_started`, spawns the
  CLI with **inherited stdio** in the repository root, classifies the exit, and records
  `agent_ended`. Relay's exit code mirrors the agent's non-zero exit code.

The launched CLI handles its own authentication. Relay passes the prompt and any explicit
model/effort selection.

---

## `relay switch <agent>`

Checkpoint, preview a handoff, then launch another agent.

**Options:** `--model <model>`, `--effort <level>`, `--operation-id <id>`, and
`--terminal-id <id>` use the same session controls as `relay run` for the incoming agent.
`--yes` is required for non-interactive launches and skips confirmation after the caller has
reviewed the generated preview. `--allow-empty-notes` overrides the continuation gate and
launches even when no unresolved continuation note exists.

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

Resume a provider-owned Claude or Codex conversation in a new interactive PTY. Use exactly one
of `--picker`, `--latest`, or `--id <value>`; picker is the default. Claude also supports
`--fork`. An optional `--prompt`, `--model`, or `--effort` applies to the resumed launch. Relay
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

## `relay checkpoints` / `relay checkpoint-diff <id>`

List retained checkpoints or read the selected checkpoint's saved bounded patch. Both support
`--json`. The reader validates IDs and artifact paths, rejects symlinks, omits binary patch
bodies, and never changes Git state.

---

## `relay usage`

Show how much each registered agent has been used during the current task.

**Option:** `--json` — print a machine-readable summary (used by the desktop Usage panel).

The numbers come entirely from Relay's own `agentHistory` — run counts, total active
duration, when each agent last ran, and its last exit reason. Relay does **not** read
provider quotas, token counts, or credential files, so it reports only what it observed while
launching agents itself. Agents that have never run are listed with zero runs.

`--json` additionally includes a `plans` array with provider plan usage where a
machine-readable source exists: Claude (sanitized `rate_limits` captured from Claude Code's
status line into `~/.relay/provider-usage/claude.json`) and Codex (numeric `rate_limits`
fields parsed from bounded tails of recent local Codex session logs). Providers without a verified source
report `status: "unknown"` instead of a guess. Captured values become `stale` after 15 minutes
or after their reset time passes. No credentials are read; Codex rollout files are scanned
locally for numeric rate-limit events only.

---

## `relay finish`

Create a final checkpoint and mark the task completed.

**Option:** `--run-tests` — run the configured test command before completing.

Behavior:

- With `--run-tests`: requires `tests.command` in config; runs it via a shell with inherited
  stdio; records a `TestResult` (`passed`/`failed`, exit code, duration). If tests fail,
  Relay records the result and then errors without completing the task.
- Creates a final checkpoint labeled `Final`.
- Sets task status to `completed`, clears the current agent, and appends a `task_completed`
  event.
- **Never** commits, pushes, or merges.

---

## `relay doctor`

Inspect local prerequisites. Does not require a task.

Reports:

- **Git**: `ready` if in a repository, otherwise an error note.
- **Node.js**: the running `process.version`.
- **Relay**: whether `.relay/` is writable / initialized.
- A per-agent table: `Installed` (from a `PATH` scan for an executable file), and
  `Authentication` (`unknown` when installed, per the conservative policy).

> Current limitation: the `Interactive` and `Headless` columns always print `Unknown`.
> Non-interactive execution is not yet implemented in the adapters, so these are honest
> placeholders rather than probed capabilities. See [agents.md](agents.md).

---

## Exit codes

- Commands throw on error; the top-level handler in `src/index.ts` prints `relay: <message>`
  to stderr and sets `process.exitCode = 1`.
- `run` and `switch` propagate the launched agent's non-zero exit code.
