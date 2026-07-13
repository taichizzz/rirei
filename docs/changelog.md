# Changelog

This file records user-visible changes made to Relay and its Rirei desktop app. The `relay`
CLI command and `.relay/` state directory retain their existing names when the desktop app
branding changes.

## 2026-07-13

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
