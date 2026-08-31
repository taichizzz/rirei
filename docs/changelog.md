# Changelog

This file records user-visible changes made to Relay and its Rirei desktop app. The `relay`
CLI command and `.relay/` state directory retain their existing names when the desktop app
branding changes.

## 0.1.0-alpha.4.1 - 2026-08-31

### Provider-aware control room hardening

- Added a skippable desktop first-run flow that validates the selected Git repository and
  reports installed CLIs, sign-in checks, installation probe failures, and each provider's
  verified usage-reporting capability.
- Added visible model-catalog discovery states to desktop onboarding, launch dialogs, profiles,
  and TUI startup/refresh so slow provider probes no longer look like a frozen interface.
- Added provider-aware model and effort selectors to desktop and TUI launches, including custom
  model IDs and backend validation of model-specific effort levels.
- Rebuilt `relay tui` as a responsive, mouse-capable control room with clickable launch/session
  actions, bounded session lists, safe alternate-screen cleanup, and raw attach/detach behavior.
- Added a dedicated TUI usage view and clearer desktop plan cards that show remaining capacity,
  stale/read-error/unsupported states, exact capture times, and exact quota reset times.
- Hardened detached terminal startup against duplicate worktree claims, shutdown races, delayed
  lifecycle reports, and premature bridge updates; bridge registration now uses bounded retry.
- Improved Windows behavior by hiding helper process windows and retaining ConPTY-safe process,
  port, shell, and daemon handling across CLI and desktop launch paths.
- Added packed lifecycle wrappers for Claude-adjacent hooks, Codex, and OpenCode, plus integration
  tests for TUI interaction payloads, desktop provider presentation, and daemon forwarding.
- Bundled the JSX runtime required by packaged desktop CLI launches and added an isolated packaged
  CLI smoke check so the app does not depend on the development `node_modules` tree.

## 0.1.0-alpha.4 - 2026-08-26

### Cross-platform terminal dashboard

- Added `relay tui`, an interactive dashboard for Windows Terminal, macOS, and Linux with
  active-session status, recent projects and worktrees, provider usage gauges, and keyboard
  launch shortcuts.
- Added raw terminal passthrough with resize synchronization and `Ctrl+]` detachment, allowing
  sessions to continue under the background daemon and be reattached later.
- Added `relay daemon --internal` and platform-aware daemon supervision so the TUI can start,
  reconnect to, and safely stop terminal sessions independently of Electron.
- Replaced the default Python PTY bridge with `node-pty`, using ConPTY on Windows and native
  PTYs on Unix while retaining the existing daemon protocol and bounded output replay.
- Added cross-platform runtime paths, Windows named pipes, `%PATHEXT%` executable discovery,
  shell selection, process-tree cleanup, and TCP port discovery.
- Added Windows, macOS, and Linux CI coverage with packed-install, daemon startup, PTY,
  package-content, and production-audit release gates.

## 0.1.0-alpha.3 - 2026-08-25

### Translucent window material

- Rirei's window is now translucent on macOS. The window requests a clear background with
  `vibrancy: 'under-window'`, so macOS composites its own blurred material behind the app.
  Other platforms keep the previous opaque background.
- Renderer surfaces became graduated translucent scrims (`--chrome`, `--rail`, `--stage`,
  `--terminal`, `--field`). The terminal stays the densest surface at 88% so agent output
  remains readable over any desktop; macOS supplies the blur, so no surface uses
  `backdrop-filter` for it.
- Dialogs are unchanged in contrast. New opaque `--panel` / `--panel-inset` tokens keep modal
  panels, checkpoint patches, and profile previews solid, and the modal veil was raised to 88%
  to cover what the translucent window now lets through.
- The terminal canvas is created with `allowTransparency: true`, which gives up xterm's opaque
  background fast path; `docs/desktop.md` records how to trade the look back for throughput.
- Added a `prefers-reduced-transparency` fallback that restores the opaque palette when macOS
  "Reduce transparency" is enabled, and the window now waits for `ready-to-show` so it no
  longer paints before first frame.

## 2026-08-24

### Daemon-authoritative provider lifecycle

- Added state schema v8 and activity schema v3 with normalized provider lifecycle, explicit
  permission/input attention, monotonic daemon-owned active runtime, and stale-observation
  rejection. Waiting time is never inferred as work.
- Added terminal-scoped authenticated lifecycle reporting. Claude uses official generated
  hooks; Codex uses a capability-token-authenticated app-server observer while retaining its
  native TUI; OpenCode uses an authenticated, byte-bounded loopback SSE/REST observer while
  retaining its native TUI. Observers cannot answer permissions, questions, or execute terminal
  input.
- Added complete daemon-inventory reconciliation. Live terminals are adopted after restart;
  absent terminals are orphaned without releasing their worktrees. Recent hash-verified terminal
  journals let an empty daemon inventory reconcile projects that have no live terminal.
- Updated Rirei Notch's activity decoder and collapsed status policy for schema v3, OpenCode,
  permission waits, input waits, orphan attention, and paused active-runtime display.

## 2026-08-13

### OpenCode adapter, controller identity, and orphan bidding

- Added an `opencode` agent adapter (`OfficialCliAdapter`): interactive launch seeds the TUI
  composer via `--prompt`, model overrides use `provider/model` names from `opencode models`,
  resume targets are `--continue` / `--session <id>` with fork support, and authentication
  detection reads configured providers from `opencode auth list`. The adapter is inert until
  the `opencode` binary is installed, which this build does not bundle.
- Persisted schema v7: every run lease now stores a boot-qualified controller identity
  (kind, instance ID, PID, boot ID), bridge identity and lifecycle status. Ordered v5→v6→v7
  migrations preserve existing leases and normalize canonical ownership IDs.
- Terminal-owning hosts and CLI launches now prove liveness with a heartbeat that stamps
  `lastSeenAt`; leases whose owner fails the heartbeat are orphaned without a coordinator.
  The CLI claims orphaned runs by priority-one bid before recovery.
- Added a bounded project-keyed application-support journal recording terminal lifecycle events
  (created/attached/status/resized/interrupted/stopped/closed/exit/recovered) so a frontend
  can reconcile its terminal inventory after a restart.
- `relay run` and `relay switch` now accept `opencode` as an agent. OpenCode appears in the
  desktop agent deck and launch provider selector.

## 2026-08-10

### Compact, evidence-labelled handoffs

- Added schema-version-4 handoff notes for completed work, next actions, decisions, rejected
  approaches, blockers, and questions, with declared user/agent provenance and Git anchors.
- Added `relay note`, note resolution, status compatibility projections, and searchable task
  history without exposing note text to the sanitized activity snapshot.
- Replaced final-string truncation with priority-aware rendering under a 4,000-character and
  estimated 1,000-token default budget. Full patches remain local.
- Added a versioned JSON handoff capsule, Git freshness labels, changed-file limits, checkpoint
  fingerprints, estimated token output, and interactive switch confirmation.

## 2026-08-11

### Handoff V2: compact prompts and reliable note capture

- Rendered handoffs now use a compact default contract of at most 1,200 characters and 300
  estimated tokens (200-300 or less in practice, never padded). The task request appears
  exactly once; `done` notes, passed tests, changed-file lists, and full Git details stay in
  the structured JSON capsule instead of the prompt.
- Removed successor note-recording instructions from rendered handoffs; note capture is a
  source-side lifecycle responsibility.
- Added `relay note import --stdin` for atomic, schema-validated batch note capture (one Git
  snapshot, one transaction, provenance only from CLI options, 16 KiB / 20-item bounds,
  reject-all-on-any-invalid-item).
- Unsupported note types now fail with the canonical type list and `next`/`done` guidance
  instead of silent remapping.
- `relay switch` now refuses non-interactive launches when no unresolved continuation note
  exists, unless `--allow-empty-notes` is given; interactive previews state the gap explicitly.
- `.relay/` is excluded from ordinary `git status` via the repository-local `info/exclude`
  file, installed by `relay init` and repaired automatically for older initialized
  repositories. Existing exclude contents and file modes are preserved; symlinked exclude
  files are rejected; linked worktrees are supported.
- Benchmark protocol V2 physically removes Relay state from successor repositories, validates
  predecessor note capture before any successor call, and asserts repository equality and
  prompt integrity before provider execution.
- The first five-task V2 execution is preserved as pre-hardening historical evidence in
  `benchmarks/handoff/reports/2026-08-11-v2.*`: 5/5 correct on both conditions and handoffs at
  211-274 estimated tokens. It improved on V1 handoffs (benchmark-defined non-cached tokens
  78,402 vs 132,270; wall time 348,853 ms vs 373,642 ms; 5/5 vs 4/5 correct) but did not reach
  the predeclared >=20% reduction versus the strong full-request baseline in 3/5 tasks (2/5
  reached it). The publication files redact private paths and state that a fresh run is required
  after the full HEAD/index/diff and pre-call hash gates.
- The final hardened five-task run is archived under
  `benchmarks/handoff/reports/2026-08-12-v2.*`. Both conditions were correct on 5/5 tasks, all
  15 calls completed without retry, all five captures and exact treatment prompt hashes passed,
  and no successor exposed Relay state. Treatment was 10,835 ms faster overall but used 13,553
  more benchmark-defined non-cached tokens; only 1/5 tasks reached the >=20% threshold, so the
  predeclared decision rule did not pass.

## 2026-07-26

### Multi-terminal UI and worktree integration

- The desktop app now supports launching and running up to four concurrent terminal sessions in isolated Git worktree workspaces.
- Replaced the single terminal and resize handlers with `TerminalTabsModel` and a robust multi-container terminal architecture.
- Replaced the hard-coded Map in the Electron main process with a `TerminalManager` that validates leases, captures outputs into per-tab bounded buffers, and survives renderer reloads transparently.
- Added a seamless launch dialog with integrated workspace creation options natively inside the Rirei desktop UI.

## 2026-07-25

### Multi-run leases

- Replaced the single `currentAgent`/`currentRunId` pair with an authoritative `runs` array of
  explicit run leases (schema version 3). Each lease records the run, agent, working tree,
  workspace, controller, and status. `currentAgent`/`currentRunId` remain as derived mirrors so
  existing frontends keep working.
- Enforced the core concurrency invariant: **at most one writing run per working tree**. Several
  agents may now run in one repository at the same time, as long as their worktrees differ.
  Acquire and release are idempotent, so a retried launch or duplicate exit cannot double-record.
- Added `relay run --workspace <id>`, which launches the provider with its working directory set
  to that workspace's worktree instead of the main tree.
- `relay workspace cleanup` now reports the active run holding a workspace and blocks cleanup
  while a lease is held. `relay status` lists active runs.
- Migrating a v2 state with an in-flight run produces an `orphaned` lease rather than a running
  one: after an upgrade the owning process is gone, and Relay does not claim to know whether the
  provider still runs.

### Worktree workspaces

- Added `relay workspace create`, which gives a concurrent agent an isolated Git branch and
  linked worktree via `git worktree add -b rirei/<slug>-<role>-<id>`. This is Relay's first and
  only Git-mutating command: it is previewed, additive, never touches the main working tree, and
  never merges, resets, force-deletes, rebases, or pushes. Worktrees live outside the repository
  under the Rirei data home (`~/.local/share/rirei/worktrees/`, overridable with
  `RIREI_DATA_HOME`).
- Added `relay workspace list` and `relay workspace cleanup <id>`. Cleanup is inspection-only:
  it reports dirty/untracked files, commits ahead of base, and unpushed commits, then prints
  copyable `git worktree remove` / `git branch -d` commands. Relay does not run them, and blocks
  nothing destructively because it removes nothing.
- Workspaces are recorded in a lock-protected `.relay/workspaces.json` registry; creation runs
  under the repository writer lock and reports exactly what was created if a step fails.

### State revision, writer lock, and schema migrations

- Added a monotonic `revision` to persisted Relay state and a repository-scoped writer lock
  (atomic `.relay/state.lock` directory) so concurrent terminals cannot clobber each other.
  A lock left behind by a crashed process is reclaimed; a live lock makes the caller wait and
  then fail loudly rather than overwrite.
- Routed every read-modify-write through a single locked `updateState()` path with optional
  `expectedRevision` optimistic-concurrency and `opId` idempotency guards. Launching an agent
  now acquires a single run lease under the lock, and run finalization is idempotent, so a
  retry or duplicate exit callback cannot double-record a run.
- Added an ordered schema-migration chain. Older `state.json` files are upgraded on read
  (bumping to schema version 2), the pre-migration file is backed up under `.relay/backups/`
  before the first upgraded write, and a `schemaVersion` newer than the running build is
  refused with an actionable message. Persistent schema versions stay separate from `--json`
  API versions.
- Abandoned state temp files are swept safely after validating their name and location.

## 2026-07-21

### Resume, history, usage, notifications, and checkpoints

- Added native Claude and Codex session resume through provider pickers, latest-session
  selection, exact IDs, and Claude session forks. New Claude runs receive a durable provider
  session ID, while Relay continues to launch each resume in a fresh PTY.
- Added project-scoped searchable task metadata history. Completed tasks are archived under
  `.relay/tasks/` before a new task replaces them; prompts, responses, and terminal transcripts
  are not indexed.
- Moved sanitized Claude plan usage to `~/.relay/provider-usage/claude.json`, removed false
  timer-based freshness, bounded Claude/Codex collection, and added per-window freshness.
- Added in-app-lifetime native notifications for agent exits, task completion, manual
  checkpoints, and critical usage thresholds, with fixed privacy-safe text and reset-cycle
  deduplication.
- Added a read-only checkpoint history and diff viewer plus safe `relay checkpoints` and
  `relay checkpoint-diff` commands. Viewing saved artifacts never changes Git state.
- Added `relay recover --force` for explicitly clearing abandoned run state after confirming
  the provider process has stopped.

## 2026-07-14

### Agent session timeline

- Added a Sessions counter and newest-first timeline to Rirei's task dashboard.
- Added per-session provider, relative launch time, start/end timestamps, calculated duration,
  active/completed/cancelled/failure styling, classified exit reason, and exit code.
- Persisted explicit model and effort overrides with each new agent-run record. Missing values
  are displayed as Auto and correctly mean Relay delegated selection to the provider.
- Exposed the complete chronological `agentHistory` through `relay status --json`; the normal
  human-readable status remains compact.
- Added stable run IDs plus model/effort metadata to `agent_started` events and the same run ID
  to `agent_ended`, making repeated launches correlatable in the append-only audit log.
- Kept schema-version-1 compatibility by making the new run fields optional, so existing task
  state needs no migration.
- Added lifecycle coverage proving launch-profile metadata reaches state, structured status,
  and the event log.
- Documented timeline rendering, refresh behavior, exit classification, Auto semantics,
  persistence, backward compatibility, and the no-transcript privacy boundary.

## 2026-07-13

### Application icon

- Added `AppIcon.icns` as the Rirei macOS application and Dock icon through the app bundle.
- Configured Electron Builder and the installed local bundle to use the same icon resource.

### Model and effort profiles

- Added a persistent per-agent model and effort picker to Rirei.
- Added live Codex model/reasoning discovery through `codex debug models` and an Antigravity
  catalog verified through `agy models`.
- Added verified Claude aliases and effort levels plus custom model ID support.
- Added `relay agents --json` for machine-readable adapter capabilities.
- Added `--model` and `--effort` session overrides to `relay run` and `relay switch` without
  changing provider-global configuration.

### Task dashboard

- Added structured `relay status --json` output for desktop and future integrations.
- Added a compact Rirei dashboard with task/status, active agent, Git state, latest
  checkpoint/test, remaining work, decisions, and blockers.
- Added automatic dashboard refresh after commands, project selection, agent launch/exit, and
  application startup.

### Provider plan usage

- Replaced the observed-runtime Usage panel with provider plan usage remaining.
- Added Claude Code 5-hour and 7-day used/remaining percentages and reset times through the
  official status-line `rate_limits` JSON fields.
- Added a generated, session-only Claude settings file and collector under `.relay/runtime/`.
- Persisted only sanitized percentages and reset timestamps under `.relay/provider-usage/`;
  the full status payload and provider credentials are never stored.
- Added Codex plan usage from numeric `rate_limits` events in local Codex rollout telemetry.
- Marked provider data stale after 15 minutes or after its reset window passes.
- Kept Gemini and Antigravity `Unknown` until a verified structured integration is available;
  Rirei does not infer or invent percentages.

### Reliability and packaging

- Unified local and packaged CLI execution on one self-contained `dist/index.cjs` artifact.
- Locked project and task controls while an interactive agent is running and added a
  **Show terminal** recovery action.
- Added stable IDs to agent-run records and merge agent exit results into the newest state so
  checkpoints or task completion cannot be overwritten by a stale pre-launch snapshot.
- Added explicit stale/live provider usage states and corrected usage card layout/status dots.
- Excluded generated app bundles, OS metadata, Python caches, and release output from Git.

### Rirei desktop name

- Renamed the Electron desktop product from Relay to **Rirei**.
- Updated the window title, visible wordmark, macOS product name, and bundle identifier.
- Kept the standalone command as `relay` and local task state under `.relay/` for compatibility.
- Kept `Relay Launcher.app` unchanged because it is the separate AppleScript Terminal launcher.

### Observed activity windows (superseded)

This first interpretation of "usage" was replaced by **Provider plan usage** above after the
product requirement was clarified.

- Added rolling **last 5 hours** and **last 7 days** activity to `relay usage --json`.
- Added aggregate run counts and active time for both windows.
- Added per-agent window totals and clipping for runs that cross a window boundary.
- Redesigned Rirei's Usage panel with summary cards and relative activity bars.
- Clarified that the panel reports only runs observed by Relay for the current task; it does
  not expose provider quota, token consumption, or remaining subscription allowance.
- Added automated coverage for completed and currently running sessions across both windows.
