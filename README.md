# Rirei

Rirei is a local coding-agent orchestration harness. It runs officially installed provider
CLIs in real terminals, gives concurrent agents isolated Git worktrees, and preserves a
provider-independent task record so work can move between agents without copying credentials or
raw conversations.

`relay` is Rirei's scriptable orchestration engine and CLI. The Rirei desktop app is one
frontend over that engine. A future TUI will be another frontend, not a separate product.

Rirei is pre-release software. Review [Security](docs/security.md) and
[Publication](docs/publication.md) before distributing builds.

## What relaying means

Rirei does not transfer a live conversation from one provider to another. It relays the work:

1. `relay start` records the task and Git baseline.
2. `relay run <provider>` launches that provider's official CLI in the selected working tree.
3. `relay note` records short decisions, failed approaches, blockers, questions, and next
   actions with declared provenance and a Git freshness anchor.
4. Checkpoints save bounded local Git metadata and patches without committing anything.
5. `relay switch <provider>` creates a checkpoint, renders a compact handoff from structured
   notes, verified Git facts, and timestamped test history, then launches after a preview.
6. The new provider sees the same files plus the handoff summary. Authentication, hidden
   reasoning, and provider conversation history stay with the original provider.

This makes Rirei closer to a **local control plane and durable harness** than an AI agent itself.
It does not choose architecture, write code, or call model APIs on its own.

## Token and cost model

Rirei itself consumes no model tokens and has no provider backend. The official CLI it launches
uses your existing subscription or API billing exactly as if you launched it manually.

The only additional model input is the prompt or handoff supplied at launch. Default handoffs
are bounded to 1,200 characters and an estimated 300 input tokens using the common
four-characters-per-token estimate, and the task request appears exactly once with no
note-recording instruction. Full checkpoint
patches remain local and are not inserted into handoffs. Every additional provider launch still
starts a model turn, so unnecessary switching can cost more than continuing an existing
provider session.

## Documentation

Detailed docs live in [`docs/`](docs/README.md):

- [Architecture](docs/architecture.md) — module layout and how a command executes end to end.
- [CLI reference](docs/cli-reference.md) — every command, its options, and exact behavior.
- [Configuration](docs/configuration.md) — `.relay/config.json` schema and which fields are honored.
- [State and activity](docs/state-and-events.md) — the `RelayState` schema, migrations, and sanitized activity projection.
- [Checkpoints and handoff](docs/checkpoints-and-handoff.md) — snapshot contents and the handoff format.
- [Agent adapters](docs/agents.md) — the adapter contract and exit classification.
- [Desktop app](docs/desktop.md) — the Electron shell and the integrated xterm.js terminal.
- [Security](docs/security.md) — auth boundary, Git safety, path policy, and secret handling.
- [Development](docs/development.md) — build, test, lint, and packaging.
- [Contributing](CONTRIBUTING.md) — development and safety expectations.
- [License](LICENSE) — MIT license for this repository.

## Development

Requires Node.js 22.12 or newer.

```sh
npm install
npm run dev -- init
npm run dev -- start "Add Google and GitHub OAuth login"
npm run dev -- status
npm run dev -- checkpoint --message "Before handoff"
npm run dev -- note decision "Use PKCE" --reason "Required for public clients"
npm run dev -- note rejected "Store tokens in localStorage" --reason "XSS exposure"
npm run dev -- note next "Add refresh-token rotation tests"
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
output. A durable agent-session timeline shows every launch for the task, including the
provider, session model/effort overrides, start and end times, duration, and classified exit
result. Active sessions update when the dashboard refreshes, and historical sessions remain
available after the agent exits or the task completes.

Each agent row also has a persistent session-profile picker. Claude exposes verified aliases
and effort levels, Codex loads its live model catalog and model-specific reasoning levels,
and Antigravity offers a catalog verified against `agy models`. Auto always preserves the provider's
default, and custom model IDs are supported without changing global provider configuration.

After installing development dependencies, use `npm run desktop:dev` or build DMG and ZIP artifacts with `npm run desktop:build`. The existing AppleScript launcher remains available unchanged.

Rirei's Usage panel reports provider plan usage when a supported machine-readable source is available. Claude and Codex show 5-hour and weekly remaining percentages and reset times; stale values are labeled explicitly. Gemini and Antigravity remain `Unknown` until a verified structured source exists. Rirei never invents percentages or reads provider credentials.

### Integrated terminal internals

Interactive agents run through `desktop/pty_bridge.py`, which allocates a real PTY so provider CLIs behave exactly as they do in a normal terminal. The renderer streams raw PTY bytes into an xterm.js terminal and forwards keystrokes back over IPC; terminal dimensions (and live window resizes) are sent to the bridge on a dedicated control file descriptor so the TUI is always sized correctly. xterm.js and its fit addon are vendored under `desktop/renderer/vendor/` (no network fetch at runtime). Relay still handles no provider credentials — the launched CLI owns its own authentication.

## Authentication boundary

Relay does not authenticate with Claude Code, Codex, or Gemini, read their credential files, copy tokens, or reuse provider subscriptions as API credentials. Each official CLI remains responsible for authentication, billing, limits, and permissions.

## Local state

`relay init` creates `.relay/` with restrictive local permissions. The complete `.relay/`
directory is machine-local and Git-ignored because it can contain task text, local paths, and
working-tree patches. Relay never commits, pushes, resets, cleans, merges, or discards
repository changes.

`relay checkpoint` stores Git metadata, porcelain status, a diff stat, and a bounded patch under `.relay/checkpoints/`. `relay handoff` intentionally omits the full patch. Agent commands launch the official CLI found on `PATH` with inherited terminal I/O. `relay finish` does not run tests unless `--run-tests` is supplied and `tests.command` is configured.

## License

Rirei is licensed under the [MIT License](LICENSE). Vendored dependencies and asset provenance
are documented in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and
[ASSET_PROVENANCE.md](ASSET_PROVENANCE.md).
