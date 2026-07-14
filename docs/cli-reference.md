# CLI reference

Every Relay command must run inside a Git repository. In development, invoke commands with
`npm run dev -- <command>`; once installed, use the `relay` binary directly.

Commands that operate on a task (`checkpoint`, `handoff`, `run`, `switch`, `finish`) first
call `taskContext()`, which requires an existing task whose status is `active` or `blocked`.
If no task is active they exit with an error.

---

## `relay init`

Initialize Relay in the current repository.

- Discovers the repository root (`git rev-parse --show-toplevel`); errors if not in a repo.
- **Refuses to overwrite** an existing `.relay/` directory.
- Creates `.relay/` (`0700`), plus `checkpoints/` and `test-output/` subdirectories.
- Writes a default `.relay/config.json` (see [configuration.md](configuration.md)).
- Prints guidance that generated logs/checkpoints/test output should be git-ignored, while
  human-authored task and decision files may be committed later.

Notes / current limitations:

- `init` does **not** probe for installed agent CLIs (use `relay doctor` for that).
- `task.md`, `decisions.md`, `handoff.md`, and `events.jsonl` are **not** pre-created; they
  appear when first written.

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
  decisions, completed/remaining work, tests, checkpoints, and blockers.
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

The handoff is built from structured state (not the raw diff) and is truncated to
`handoff.maxCharacters`. See [checkpoints-and-handoff.md](checkpoints-and-handoff.md) for
the exact section layout.

> Current limitation: `handoff` prints to stdout only; it does not write `.relay/handoff.md`.

---

## `relay run <agent>`

Launch an installed official CLI (`claude`, `codex`, `gemini`, or `antigravity`) for the current task.

**Option:** `--prompt <prompt>` — use an explicit prompt instead of the generated handoff.

**Options:** `--model <model>` and `--effort <level>` — apply provider-specific session
overrides without changing global provider configuration. Unsupported effort values fail
before launch.

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

**Options:** `--model <model>` and `--effort <level>` — use the same session overrides as
`relay run` for the incoming agent.

Sequence:

1. Validate the agent id and load the active task.
2. `createCheckpoint()` with the label `Switch to <agent>`.
3. `renderHandoff()` and print the checkpoint id followed by the handoff preview.
4. `launchAgent()` for the target CLI (records `agent_started` / `agent_ended`).

> Current limitation: `switch` records agent start/end events but does not append a distinct
> `switch` event.

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
status line into `.relay/provider-usage/claude.json`) and Codex (numeric `rate_limits`
fields parsed from the newest local Codex session log). Providers without a verified source
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
