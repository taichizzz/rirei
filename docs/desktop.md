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

The window is a single translucent, terminal-first layout: a slim header (wordmark + project
chooser), one control band (Task / Agents / Session groups), a compact task dashboard, and an
integrated terminal that fills all remaining window height. See
[Window material](#window-material) for how the translucency is built.

On first run, a skippable setup dialog validates the selected Git repository before saving it.
It then checks the same executable path used by provider launches and reports each CLI's
installation state, conservative sign-in status, and usage-reporting support. A missing CLI or
verified sign-in failure is actionable; providers that do not expose machine-readable sign-in or
quota status are labeled as unsupported or checked on launch rather than guessed.

1. **Project** (top right) — choose your Git repository folder.
2. **Initialize** (Session group) — runs `relay init` (creates `.relay/`). Required once per repo.
3. **Describe a task** and click **Start task** — runs `relay start` (creates the active
   task). An agent cannot launch without an active task.
4. **Run** (or **Switch**) next to Claude / Codex / Antigravity / OpenCode — launches the
   agent in the terminal. **Resume** opens Claude, Codex, or OpenCode's native session
   resume. The panel switches to the live terminal and **now accepts typing**.

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
- **Gemini / Antigravity / OpenCode** — no verified machine-readable quota interface; shown
  as `Unknown` rather than an inferred percentage.

Provider values captured more than 15 minutes ago, from an invalid/future timestamp, or past
their reset time remain visible but are labeled `Stale`. Each window is evaluated separately,
and unchanged status-line payloads do not refresh the sample timestamp. Cards show the exact
local capture and reset timestamps with seconds and timezone, alongside relative freshness.

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

The terminal header's **+** button opens a per-session launch dialog with the same provider-aware
model and effort choices plus workspace selection. Onboarding, profiles, and launch dialogs show
an explicit loading state while model catalogs and sign-in capabilities are being discovered;
catalog failure still leaves provider-default and custom model launches available.

- Claude: `--model` and `--effort` (`low`, `medium`, `high`, `xhigh`, `max`).
- Codex: `--model` and a session-only `model_reasoning_effort` config override; effort options
  come from each live catalog entry.
- Antigravity: `--model`; effort is represented by verified model variants from `agy models`
  because that command requires a TTY and cannot be queried safely in the background.
- OpenCode: `--model` in `provider/model` form; no separate verified effort flag.
- Gemini: `--model`; no separate verified effort flag.

If you click **Run** before steps 2–3, the panel shows the reason (e.g. "Start a Relay task
before running an agent") in the command-output view instead of going live. **Stop** sends
`Ctrl+C` to the session; **Clear** clears the terminal (or restores the how-to text when idle).

> **Packaged copies go stale.** The installed `/Applications/Rirei.app` bundles `desktop/`
> into `Contents/Resources/app.asar` at build time — code changes do not reach it until it is
> rebuilt with `npm run desktop:build`, which writes `dist/mac-arm64/Rirei.app`. When testing
> changes, prefer `npm run desktop:dev`, which always runs the current source.
>
> Rebuilding needs an ad-hoc signature, because the available Apple Development certificates
> are expired and electron-builder therefore skips signing. This repository lives in an
> iCloud-synced folder, which continually re-adds the `com.apple.FinderInfo` attribute that
> `codesign --verify --deep --strict` rejects, so stage the bundle outside the synced tree
> before signing:
>
> ```
> ditto --norsrc --noextattr --noacl dist/mac-arm64/Rirei.app /tmp/stage/Rirei.app
> codesign --force --deep -s - /tmp/stage/Rirei.app
> codesign --verify --deep --strict /tmp/stage/Rirei.app
> ```
>
> Quit Rirei **and** its terminal daemon before replacing an installed copy; the daemon
> outlives the window and keeps referencing paths inside the old bundle.
>
> Launch the app with `npm run desktop:dev` from a terminal rather than double-clicking a
> packaged `.app`. A Finder-launched app does not inherit your shell `PATH`, so the
> `claude` / `codex` / `gemini` / `node` executables may not be found and **Run** will fail
> to start. `main.mjs` augments `PATH` with `~/.local/bin`, `/opt/homebrew/bin`, and
> `/usr/local/bin`, but agents installed elsewhere (e.g. under a version manager) need the
> inherited PATH that `desktop:dev` provides.

## Two execution paths

The app routes work down one of two paths depending on the command:

| Path            | Commands                                                               | Mechanism                                                      | Where output goes                   |
| --------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------- |
| Non-interactive | `init`, `start`, `status`, `doctor`, `checkpoint`, `handoff`, `finish` | `runCli()` spawns the CLI, captures stdout/stderr              | Printed into the `#output` pane     |
| Interactive     | `run`, `switch`, `resume`, `shell`                                     | The daemon spawns the command inside a PTY via `pty_bridge.py` | Streamed into the xterm.js terminal |

Interactive sessions require an initialized project (`.relay/config.json`) and an active task
(`.relay/state.json`), and up to **four** terminal sessions may run concurrently, optionally
backed by Git worktree workspaces.
While sessions are active, project selection is disabled. Usage remains
available because it is read-only, and terminal tabs restore the live PTY view per agent.
Reloading the renderer reconnects to the detached terminal daemon and replays bounded output
buffers. The daemon, rather than a renderer or window, owns live PTYs, so sessions remain
controlled while the desktop UI reconnects.

The daemon also owns provider lifecycle and active runtime. It advances runtime only while a
session is starting or working, freezes it for permission/input waits, and publishes the
normalized result through Relay state and the schema-v3 activity feed consumed by Rirei Notch.
At reconnect it reconciles complete daemon inventory against both live terminal projects and
recent hash-verified terminal journals. Missing terminals become orphaned but their worktrees
remain claimed until explicit recovery.

## Why an integrated terminal (and not a `<div>`)

Provider CLIs are full-screen terminal UIs: they use the alternate screen buffer, move the
cursor, set colors, and emit OSC sequences (window title, color queries). A plain element
that appends text and strips a subset of escape codes cannot render them — the output spills
one character per line and keystrokes have nowhere to go.

The app therefore uses a real terminal emulator, **xterm.js**, fed by a real PTY. The agent
behaves exactly as it would in Terminal.app.

## Window material

The window is translucent on macOS. `createWindow()` requests a clear background
(`#00000000`) plus `vibrancy: 'under-window'` and `visualEffectState: 'active'`, so macOS
composites its own blurred material behind the web contents. Every other platform keeps the
original opaque `#000000` background; the choice is isolated in `windowMaterial()`.

Because the OS supplies the blur, no renderer surface uses `backdrop-filter` for it — the CSS
only has to be translucent enough to let the material through. Opacity is **graduated**, and
that is deliberate: chrome is the most transparent, the terminal the least, because agent
output has to stay readable over an arbitrary desktop.

| Token        | Applies to            | Opacity |
| ------------ | --------------------- | ------- |
| `--stage`    | `.main-stage`         | 55%     |
| `--rail`     | `.controls`           | 58%     |
| `--chrome`   | `.bar`                | 62%     |
| `--terminal` | `#terminalsContainer` | 88%     |
| `--field`    | inputs, textareas     | 38%     |

`html`, `body`, and `.dashboard` stay fully clear: the bar, rail, and stage already tile the
window, and painting a second scrim over the first would compound the opacity.

Dialogs are exempt. They sit above the veil rather than the desktop, so `--panel` and
`--panel-inset` are opaque and modal panels, patch viewers, and profile previews keep exactly
the contrast they had before. The veil itself was raised to 88% because it now also has to
cover whatever the translucent window lets through.

Two consequences worth knowing:

- **xterm.** The terminal canvas is created with `allowTransparency: true` and a clear theme
  background so the `--terminal` scrim shows through it. This gives up xterm's opaque
  background fast path, which costs throughput on heavy output. To trade the look back for
  that throughput, set `allowTransparency: false` and `theme.background` to `'#080a09'` in
  `createXterm()`. `vendor/xterm.css` also paints `.xterm-viewport` opaque black for macOS
  scrollbar rendering; `styles.css` overrides that rather than patching the vendored file.
- **Reduce transparency.** macOS switches the vibrancy material off when that accessibility
  setting is on, which would leave the scrims compositing against a clear window. A
  `@media (prefers-reduced-transparency: reduce)` block restores the original opaque palette
  and drops the modal blur.

## Components

```
desktop/
├── main.mjs                     # Electron main process: windows, IPC, daemon client
├── terminal-daemon.mjs          # Detached daemon entrypoint and session owner
├── terminal-daemon-server.mjs   # Authenticated socket server, PTYs, bounded output
├── terminal-daemon-protocol.mjs # Framing and protocol validation
├── provider-lifecycle-hook.cjs  # Terminal-scoped status-only daemon reporter
├── codex-lifecycle-wrapper.mjs  # Native TUI plus passive app-server observer
├── opencode-lifecycle-wrapper.mjs # Native TUI plus authenticated SSE observer
├── terminal-journal.mjs         # Durable restart reconciliation evidence
├── terminal-control.mjs         # PTY bridge control frames
├── pty_bridge.py                # Allocates a PTY, relays bytes, applies terminal size
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
- Reads versioned newline-delimited control frames on **file descriptor 3** for resize,
  interrupt, terminate, and kill actions. Resize applies `TIOCSWINSZ`; provider supervisors
  receive signals without prematurely killing the Relay controller that must finalize state.

Requires the system `python3` at `/usr/bin/python3` (macOS ships this).

Packaged apps unpack the daemon entry, its static import closure, and `pty_bridge.py` beside
`app.asar`; Python cache directories and `.pyc`/`.pyo` files are excluded from the bundle.

### `main.mjs`

- `runCli(project, command, args)` — spawns the CLI with piped stdio for non-interactive
  commands and resolves `{ ok, output }`.
- `startTerminal(event, project, command, agent, size)` — sends a validated start request to
  the detached daemon, which launches `pty_bridge.py` and owns the resulting PTY.
- Managed terminals are keyed by generated terminal ID, not renderer ID. Every terminal IPC
  action validates both terminal identity and owning `webContents`; the CLI receives the same
  value as its operation and terminal IDs, linking the PTY to its durable run lease.
- The CLI path resolves to packaged `cli/index.cjs` when bundled, or `dist/index.cjs` in
  development; `node` is located at `/usr/local/bin/node`, `/opt/homebrew/bin/node`, or the
  `node` on `PATH`.
- `windowMaterial()` returns the platform's window background: the macOS vibrancy request, or
  an opaque `#000000` elsewhere. Windows are created hidden and shown on `ready-to-show`, so a
  clear-backgrounded window never paints before its first frame. See
  [Window material](#window-material).

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

The desktop app changes nothing about provider-account authentication. Interactive agents
authenticate themselves exactly as they do from a normal shell; Relay never reads provider
credentials. Local lifecycle control uses a random terminal-scoped token, Codex uses a random
per-launch WebSocket capability token, and OpenCode uses a random per-launch loopback-server
password. None is written to Relay state, activity, history, output, or notifications. See
[security.md](security.md).

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
