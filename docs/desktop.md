# Rirei desktop app

Rirei is the Electron desktop app (`desktop/`) for the Relay CLI. It gives you
a folder picker, buttons for the non-interactive task commands, and — the important part — an
**integrated terminal** where interactive agents run and render correctly.

Run it in development with `npm run desktop:dev` (builds the CLI, then launches Electron), or
package DMG/ZIP artifacts with `npm run desktop:build`.

## Using the app (activation flow)

The integrated terminal supports both managed agent sessions and ordinary login-shell tabs.
Choose **Shell** after selecting a project to run commands such as `git status`, tests, editors,
or any other interactive terminal program without initializing Relay first. The agent flow is:

The window is a single black, terminal-first layout: a slim header (wordmark + project
chooser), one control band (Task / Agents / Session groups), a compact task dashboard, and an
integrated terminal that fills all remaining window height.

1. **Project** (top right) — choose your Git repository folder.
2. **Initialize** (Session group) — runs `relay init` (creates `.relay/`). Required once per repo.
3. **Describe a task** and click **Start task** — runs `relay start` (creates the active
   task). An agent cannot launch without an active task.
4. **Run** (or **Switch**) next to Claude / Codex / Antigravity — launches the agent in the
   terminal. **Resume** opens Claude or Codex's native session picker. The panel switches to
   the live terminal and **now accepts typing**.

The **Usage** button (Session group) shows provider plan usage remaining when a
machine-readable source is available:

- **Claude** — Claude Code passes documented `rate_limits` fields (5-hour and 7-day used
  percentage plus reset epoch) to its status line. Launching Claude through the app injects
  a status-line collector via `--settings`; after the first prompt in that session, the
  sanitized fields land in `~/.relay/provider-usage/claude.json` and the panel reports them
  across projects. Existing project-local samples remain readable as a compatibility fallback.
- **Codex** — the Codex CLI records the same class of telemetry (`rate_limits` with
  `used_percent`, window length, reset time, plan type) in its local session logs under
  `~/.codex/sessions/`. Rirei parses only those numeric fields from the newest session —
  conversation content is never read into Relay state. Any Codex run (inside or outside
  Rirei) refreshes this.
- **Gemini / Antigravity** — no verified machine-readable quota interface; shown as
  `Unknown` rather than an inferred percentage.

Provider values captured more than 15 minutes ago, from an invalid/future timestamp, or past
their reset time remain visible but are labeled `Stale`. Each window is evaluated separately,
and unchanged status-line payloads do not refresh the sample timestamp.

The **Task dashboard** reads `relay status --json` and shows the active task/status, current
agent, branch and changed-file count, latest checkpoint/test, remaining work, decisions, and
blockers. It refreshes after task commands, agent launch/exit, project selection, manual
Refresh, and application startup for a remembered project.

The dashboard's **History** action searches current and archived task metadata, including
providers, models, effort, outcomes, and checkpoint labels. It never records conversation or
terminal transcripts. Known Claude/Codex provider session IDs can be resumed directly from a
history result. The checkpoint metric opens a read-only list and saved patch viewer; the patch
is the change captured against that checkpoint's Git base, not a comparison between Relay
checkpoints.

While Rirei is open it polls sanitized provider usage about once per minute and may display
native notifications for agent exits, task completion, manual checkpoints, and 20%/5% usage
remaining thresholds. Routine notifications are suppressed while the window is focused;
closing Rirei stops polling and notifications.

### Agent session timeline

The dashboard's **Sessions** button displays the number of agent launches recorded for the
current task and opens a newest-first timeline. Each entry shows:

- Provider name and relative launch time.
- Running, completed, cancelled, or failed visual state.
- The explicit model and effort overrides passed for that launch. **Auto** means Relay passed
  no override and left the final choice to the provider.
- Local start and end timestamps plus a derived duration. A live entry uses the current time
  until the provider exits.
- The adapter-classified exit reason and process exit code. Unknown failures remain labeled
  conservatively rather than being reinterpreted by the renderer.

The timeline is derived entirely from `agentHistory` returned by `relay status --json`; the
renderer does not create a separate history database. This means entries survive desktop
restarts, remain visible for completed tasks, and stay ordered consistently with CLI state.
Older state files remain compatible because the newly recorded model and effort fields are
optional. The view updates whenever the normal dashboard refreshes, including shortly after
launch and when the PTY reports exit. It records metadata only—no prompt, response, terminal
transcript, credentials, or provider conversation content is displayed or added to state.

Each agent row includes a **session profile** button. The picker discovers installed CLI
versions and current model catalogs, offers only provider-supported effort levels, supports a
custom model ID, previews the launch selection, and stores preferences per provider in desktop
`localStorage`. Auto delegates model/effort selection to the provider. Saved selections are
passed only for that launch and never rewrite the provider's global configuration.

- Claude: `--model` and `--effort` (`low`, `medium`, `high`, `xhigh`, `max`).
- Codex: `--model` and a session-only `model_reasoning_effort` config override; effort options
  come from each live catalog entry.
- Antigravity: `--model`; effort is represented by verified model variants from `agy models`
  because that command requires a TTY and cannot be queried safely in the background.
- Gemini: `--model`; no separate verified effort flag.

If you click **Run** before steps 2–3, the panel shows the reason (e.g. "Start a Relay task
before running an agent") in the command-output view instead of going live. **Stop** sends
`Ctrl+C` to the session; **Clear** clears the terminal (or restores the how-to text when idle).

> **Packaged copies go stale.** A previously built `Rirei.app` (e.g. under `release/`)
> contains a frozen copy of `desktop/` from build time — code changes do not reach it until
> it is rebuilt (and re-signed with `codesign --force --deep -s -`). When testing changes,
> prefer `npm run desktop:dev`, which always runs the current source.
>
> Launch the app with `npm run desktop:dev` from a terminal rather than double-clicking a
> packaged `.app`. A Finder-launched app does not inherit your shell `PATH`, so the
> `claude` / `codex` / `gemini` / `node` executables may not be found and **Run** will fail
> to start. `main.mjs` augments `PATH` with `~/.local/bin`, `/opt/homebrew/bin`, and
> `/usr/local/bin`, but agents installed elsewhere (e.g. under a version manager) need the
> inherited PATH that `desktop:dev` provides.

## Two execution paths

The app routes work down one of two paths depending on the command:

| Path            | Commands                                                               | Mechanism                                                         | Where output goes                   |
| --------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------- |
| Non-interactive | `init`, `start`, `status`, `doctor`, `checkpoint`, `handoff`, `finish` | `runCli()` spawns the CLI, captures stdout/stderr                 | Printed into the `#output` pane     |
| Interactive     | `run`, `switch` (for `claude`/`codex`/`gemini`)                        | `startTerminal()` spawns the CLI inside a PTY via `pty_bridge.py` | Streamed into the xterm.js terminal |

Interactive sessions require an initialized project (`.relay/config.json`) and an active task
(`.relay/state.json`), and up to **four** terminal sessions may run concurrently, optionally
backed by Git worktree workspaces.
While sessions are active, project selection is disabled. Usage remains
available because it is read-only, and terminal tabs restore the live PTY view per agent.
Reloading the renderer reconciles with the main-process terminal inventory and replays bounded output
buffers. Rirei blocks window/app closure while providers are active; stop them and wait for their
exit before quitting so process ownership never becomes silently uncertain.

## Why an integrated terminal (and not a `<div>`)

Provider CLIs are full-screen terminal UIs: they use the alternate screen buffer, move the
cursor, set colors, and emit OSC sequences (window title, color queries). A plain element
that appends text and strips a subset of escape codes cannot render them — the output spills
one character per line and keystrokes have nowhere to go.

The app therefore uses a real terminal emulator, **xterm.js**, fed by a real PTY. The agent
behaves exactly as it would in Terminal.app.

## Components

```
desktop/
├── main.mjs            # Electron main process: windows, IPC, runCli, startTerminal
├── pty_bridge.py       # Allocates a PTY, relays bytes, applies terminal size
├── preload.cjs         # contextBridge: the window.relay API exposed to the renderer
└── renderer/
    ├── index.html      # Loads xterm assets + the UI
    ├── styles.css      # App styling + terminal container
    ├── renderer.js     # Drives the xterm terminal and wires IPC
    └── vendor/         # Vendored xterm.js, xterm.css, addon-fit.js (no runtime network)
```

### `pty_bridge.py`

A small Python helper that:

- `pty.fork()`s and `execvpe`s the target command (`node dist/index.cjs run codex …`) so the
  child gets a genuine controlling terminal.
- Sets the initial window size via `TIOCSWINSZ` from the `RELAY_COLS` / `RELAY_ROWS`
  environment variables (defaults 80×24).
- Forwards `SIGINT` / `SIGTERM` to the child.
- Relays bytes both ways between the PTY master and its own stdin/stdout.
- Reads newline-delimited JSON resize messages `{"cols":N,"rows":N}` on **file descriptor 3**
  (a dedicated control channel) and applies them with `TIOCSWINSZ`, so live window resizes
  reflow the agent's TUI.

Requires the system `python3` at `/usr/bin/python3` (macOS ships this).

### `main.mjs`

- `runCli(project, command, args)` — spawns the CLI with piped stdio for non-interactive
  commands and resolves `{ ok, output }`.
- `startTerminal(event, project, command, agent, size)` — spawns `pty_bridge.py` with
  `stdio: ['pipe','pipe','pipe','pipe']` (fd 3 is the resize control channel), passing
  `RELAY_COLS`, `RELAY_ROWS`, and `TERM=xterm-256color` in the environment. It augments
  `PATH` so the user's installed agent CLIs are found (`~/.local/bin`, `/opt/homebrew/bin`,
  `/usr/local/bin`).
- Managed terminals are keyed by generated terminal ID, not renderer ID. Every terminal IPC
  action validates both terminal identity and owning `webContents`; the CLI receives the same
  value as its operation and terminal IDs, linking the PTY to its durable run lease.
- The CLI path resolves to packaged `cli/index.cjs` when bundled, or `dist/index.cjs` in
  development; `node` is located at `/usr/local/bin/node`, `/opt/homebrew/bin/node`, or the
  `node` on `PATH`.

### IPC surface (`preload.cjs`)

The renderer only sees `window.relay`, exposed over `contextBridge` with
`contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`:

| `window.relay` method      | Channel                    | Direction                               |
| -------------------------- | -------------------------- | --------------------------------------- |
| `selectProject()`          | `relay:select-project`     | invoke                                  |
| `command(request)`         | `relay:command`            | invoke (non-interactive commands)       |
| `usage(request)`           | `relay:usage`              | invoke (read provider plan usage)       |
| `dashboard(request)`       | `relay:dashboard`          | invoke (read structured task status)    |
| `interactive(request)`     | `relay:interactive`        | invoke (starts a terminal)              |
| `openShell(request)`       | `relay:shell`              | invoke (starts a login-shell PTY)       |
| `workspaceList(request)`   | `relay:workspace-list`     | invoke (list workspaces)                |
| `workspaceCreate(request)` | `relay:workspace-create`   | invoke (create workspace)               |
| `terminalInput(id,data)`   | `relay:terminal-input`     | send (validated terminal → PTY stdin)   |
| `resizeTerminal(id,size)`  | `relay:terminal-resize`    | send (validated terminal → PTY fd 3)    |
| `stopTerminal(id)`         | `relay:terminal-stop`      | invoke (validated terminal Ctrl+C)      |
| `interruptTerminal(id)`    | `relay:terminal-interrupt` | invoke (validated terminal SIGINT)      |
| `closeTerminal(id)`        | `relay:terminal-close`     | invoke (remove terminal from manager)   |
| `hideTerminal(id)`         | `relay:terminal-hide`      | invoke (visually hide running agent)    |
| `terminalInventory()`      | `relay:terminal-inventory` | invoke (owned terminal inventory)       |
| `onTerminalData(cb)`       | `relay:terminal-data`      | receive (`{terminalId,data}`)           |
| `onTerminalStatus(cb)`     | `relay:terminal-status`    | receive (`{terminalId,status}`)         |
| `onTerminalExit(cb)`       | `relay:terminal-exit`      | receive (identified session ended)      |
| `onDeepLink(cb)`           | `relay:deep-link`          | receive (`{terminalId}`)                |
| `activity(request)`        | `relay:activity`           | invoke (read validated global activity) |

### `renderer.js`

- Constructs an xterm `Terminal` plus the `FitAddon`, opens it in `#terminal`.
- `term.onData(...)` forwards every keystroke (including control characters and arrow keys)
  to the PTY — no hand-rolled keymap.
- `onTerminalData` writes **raw** PTY bytes straight into xterm (`term.write(data)`), so all
  escape sequences are interpreted by the emulator.
- Before launching an agent it reveals and fits the terminal, then passes the measured
  `{cols, rows}` into the `interactive` request so the PTY starts at the correct size. A
  window `resize` listener re-fits and calls `resizeTerminal`.
- The card toggles a `live` class to switch between the command-output pane and the terminal.
- The dashboard caches the returned `agentHistory` only for rendering, updates the Sessions
  count, and rebuilds the open modal whenever fresh status arrives. Timeline durations are
  derived in the renderer from persisted timestamps rather than written back to state.

## Content Security Policy

`index.html` sets a strict CSP: `default-src 'self'; script-src 'self';
style-src 'self' 'unsafe-inline'`. Scripts and styles load only from local (`'self'`) files
— the xterm assets are vendored under `renderer/vendor/`, never fetched from a CDN.
`'unsafe-inline'` is granted for **styles only**, because xterm.js injects a `<style>`
element to size its rows; script injection remains disallowed.

## Vendored assets

`@xterm/xterm` and `@xterm/addon-fit` are copied into `desktop/renderer/vendor/`
(`xterm.js`, `xterm.css`, `addon-fit.js`). Vendoring keeps the app fully offline and
CSP-clean. To update them, reinstall the packages and re-copy the built files from
`node_modules/@xterm/*/lib` and `.../css` into `vendor/`. The `electron-builder` `files`
glob (`desktop/**/*`) includes the vendor directory in packaged builds, and
`eslint.config.js` ignores it.

## Credential boundary

The desktop app changes nothing about authentication. Interactive agents authenticate
themselves inside the terminal exactly as they do from a normal shell; Relay handles no
tokens. See [security.md](security.md).

## Deep Linking

The packaged desktop app declares and registers the `rirei://` protocol on macOS. Opening the
exact URL `rirei://terminal/<terminal-uuid>` will:

1. Validate the URL and UUID without accepting paths, commands, query parameters, or fragments.
2. Queue the intent through cold launch, renderer loading, or renderer reload.
3. Restore and focus the terminal's owning Rirei window.
4. Unhide, select, resize, and focus the corresponding terminal tab.
5. Open Sessions with a clear message when the terminal no longer exists.

## Relationship to the AppleScript launcher

`scripts/Relay Launcher.applescript` (built via `npm run launcher:build`) is a separate,
still-supported entry point that opens Terminal.app in a chosen repository so the plain
`relay` commands are available. It is unaffected by the desktop app.
