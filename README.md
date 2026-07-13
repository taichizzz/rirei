# Relay

Relay preserves provider-independent coding-task state while developers manually move work between officially installed coding-agent CLIs.

## Documentation

Detailed docs live in [`docs/`](docs/README.md):

- [Architecture](docs/architecture.md) — module layout and how a command executes end to end.
- [CLI reference](docs/cli-reference.md) — every command, its options, and exact behavior.
- [Configuration](docs/configuration.md) — `.relay/config.json` schema and which fields are honored.
- [State and events](docs/state-and-events.md) — the `RelayState` schema, atomic writes, and the event log.
- [Checkpoints and handoff](docs/checkpoints-and-handoff.md) — snapshot contents and the handoff format.
- [Agent adapters](docs/agents.md) — the adapter contract and exit classification.
- [Desktop app](docs/desktop.md) — the Electron shell and the integrated xterm.js terminal.
- [Security](docs/security.md) — auth boundary, Git safety, path policy, and secret handling.
- [Development](docs/development.md) — build, test, lint, and packaging.

## Development

Requires Node.js 22 or newer.

```sh
npm install
npm run dev -- init
npm run dev -- start "Add Google and GitHub OAuth login"
npm run dev -- status
npm run dev -- checkpoint --message "Before handoff"
npm run dev -- handoff
npm run dev -- run claude
npm run dev -- switch codex
npm run dev -- finish
npm run dev -- doctor
```

## macOS launcher

Build and install the local command and launcher:

```sh
npm run build
npm run install:local
npm run launcher:build
```

Open `Relay Launcher.app`, choose a Git repository, and Relay will initialize it if needed. Existing Relay state is preserved. The launcher opens Terminal in the selected repository so the normal `relay` commands remain available.

## Rirei desktop app

**Rirei** is the macOS Electron app for the Relay CLI. Task-control commands (`init`, `start`, `status`, `doctor`, `checkpoint`, `handoff`, `finish`) run non-interactively and print their results in the app. Interactive agents (`run`/`switch` for `claude`, `codex`, `gemini`) launch inside an **integrated terminal** built on [xterm.js](https://xtermjs.org): the agent's full-screen TUI renders correctly and accepts keyboard input directly in the window.

Its task dashboard shows live task status, current agent, Git branch and changes, latest
checkpoint/test, remaining work, decisions, and blockers from structured `relay status --json`
output.

After installing development dependencies, use `npm run desktop:dev` or build DMG and ZIP artifacts with `npm run desktop:build`. The existing AppleScript launcher remains available unchanged.

Rirei's Usage panel reports provider plan usage when a supported machine-readable source is available. Claude and Codex show 5-hour and weekly remaining percentages and reset times; stale values are labeled explicitly. Gemini and Antigravity remain `Unknown` until a verified structured source exists. Rirei never invents percentages or reads provider credentials.

### Integrated terminal internals

Interactive agents run through `desktop/pty_bridge.py`, which allocates a real PTY so provider CLIs behave exactly as they do in a normal terminal. The renderer streams raw PTY bytes into an xterm.js terminal and forwards keystrokes back over IPC; terminal dimensions (and live window resizes) are sent to the bridge on a dedicated control file descriptor so the TUI is always sized correctly. xterm.js and its fit addon are vendored under `desktop/renderer/vendor/` (no network fetch at runtime). Relay still handles no provider credentials — the launched CLI owns its own authentication.

## Authentication boundary

Relay does not authenticate with Claude Code, Codex, or Gemini, read their credential files, copy tokens, or reuse provider subscriptions as API credentials. Each official CLI remains responsible for authentication, billing, limits, and permissions.

## Local state

`relay init` creates `.relay/` with restrictive local permissions. Generated event logs, checkpoints, and captured test output belong in `.gitignore`; future human-authored task and decision files can be committed deliberately. Relay never commits, pushes, resets, cleans, merges, or discards repository changes.

`relay checkpoint` stores Git metadata, porcelain status, a diff stat, and a bounded patch under `.relay/checkpoints/`. `relay handoff` intentionally omits the full patch. Agent commands launch the official CLI found on `PATH` with inherited terminal I/O. `relay finish` does not run tests unless `--run-tests` is supplied and `tests.command` is configured.
