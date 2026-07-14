# Changelog

This file records user-visible changes made to Relay and its Rirei desktop app. The `relay`
CLI command and `.relay/` state directory retain their existing names when the desktop app
branding changes.

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
