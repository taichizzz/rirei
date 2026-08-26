# Rirei Windows & Cross-Platform TUI Platform Audit

## Overview

This document provides a comprehensive platform audit of the Rirei codebase to prepare for adding a Windows-compatible terminal user interface (`relay tui`) while preserving the existing macOS Electron desktop application.

The core architecture shares Relay state and agent adapters across both interfaces:

```text
Relay state and agent adapters
             │
    Terminal daemon protocol
             │
    Cross-platform PTY host (node-pty / ConPTY)
       ┌─────────────┴─────────────┐
Electron client (GUI)       TUI client (CLI)
```

The terminal daemon remains authoritative for PTY ownership, output ring buffering, session lifecycle, active-runtime tracking, stop escalation, reconnection, and project reconciliation. The TUI and Electron GUI are both unprivileged clients of this daemon.

---

## 1. Summary of Platform Incompatibilities by Category

### 1.1 Absolute Unix Paths

- **`/usr/bin/python3`**: Used in `desktop/terminal-daemon-server.mjs` to spawn `desktop/pty_bridge.py`. Python is not guaranteed to exist on Windows or Unix at this path, and the Python PTY bridge is Unix-only.
- **`/bin/zsh`**: Hardcoded default shell in `desktop/terminal-daemon.mjs` and `desktop/main.mjs`.
- **`/usr/sbin/lsof`**: Hardcoded in `desktop/opencode-lifecycle-wrapper.mjs` to discover open TCP listening ports on macOS.
- **`/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin:/bin:/usr/sbin:/sbin`**: Hardcoded fallback PATH lists in `desktop/main.mjs` and `desktop/terminal-daemon.mjs`.

### 1.2 Shell Executable & Argument Assumptions

- Default interactive shells on Windows are `pwsh.exe`, `powershell.exe`, or `cmd.exe` (via `%COMSPEC%`), not `/bin/zsh` or `/bin/bash`.
- The `-l` (login shell) argument passed in `terminal-daemon.mjs` (`[body.shell || '/bin/zsh', '-l']`) is specific to POSIX shells and invalid or unhandled by PowerShell / `cmd.exe`.
- Shell lifecycle hooks in `src/agents/usage-collectors.ts` embed POSIX shell script syntax:
  ```sh
  if [ -n "$RIREI_TERMINAL_ID" ] && [ -n "$RIREI_NODE_PATH" ] && [ -n "$RIREI_LIFECYCLE_HOOK" ]; then "$RIREI_NODE_PATH" "$RIREI_LIFECYCLE_HOOK" ...; fi
  ```
  On Windows, Claude Code executes hook commands via `cmd.exe`, which fails on `if [` syntax. Single-quote escaping `'...'` is also invalid in `cmd.exe`.

### 1.3 Process Tree Discovery & Termination

- `desktop/pty_bridge.py` executes `ps -axo pid=,ppid=` to traverse child and descendant processes. `ps` is unavailable on Windows.
- POSIX signal propagation (`SIGINT`, `SIGTERM`, `SIGKILL`, `SIGHUP`, `SIGUSR1`, `SIGUSR2`) via `os.kill` / `child.kill`:
  - `SIGUSR1`, `SIGUSR2`, `SIGHUP` do not exist on Windows.
  - Calling `child.kill('SIGTERM')` on Windows terminates only the parent process, leaving child/sidecar processes running as orphans.
  - Windows process-tree cleanup requires `taskkill /PID <pid> /T /F` or native Windows job objects / Toolhelp32 process snapshot APIs.

### 1.4 IPC Endpoints & Socket Assumptions

- Unix domain sockets (`.sock`) are filesystem entries created in temporary directories and removed with `rm(socketPath)`.
- On Windows, local IPC must use named pipes (`\\.\pipe\rirei-<hash>-pty-v1`).
- `lstat(socketPath).isSocket()` in `terminal-daemon-server.mjs` and `terminal-daemon-client.mjs` fails on Windows named pipes because named pipes do not exist on the standard filesystem hierarchy.

### 1.5 File Permissions & POSIX Modes

- `chmod(..., 0o700)` and `chmod(..., 0o600)` in `store.ts`, `journal.ts`, `lock.ts`, `terminal-daemon-server.mjs`, etc., do not configure Windows ACLs (Node's `chmod` on Windows only toggles the read-only attribute).
- `process.umask(0o077)` is not portable to Windows.
- `(descriptorFile.mode & 0o077) !== 0` check in `terminal-daemon-client.mjs` fails on Windows where file modes return `0o666`, causing the client to falsely reject valid descriptors.
- `process.getuid()` does not exist on Windows (`process.getuid === undefined`).
- `constants.O_NOFOLLOW` used in `usage-collectors.ts` and `git/repository.ts` is not supported on Windows.

### 1.6 Executable Resolution & Windows PATHEXT

- `src/agents/registry.ts` checks `path.join(directory, executable)` and `access(candidate, constants.X_OK)`.
  - On Windows, npm global CLIs install with `.cmd`, `.bat`, or `.exe` extensions (e.g. `claude.cmd`, `codex.cmd`, `opencode.exe`).
  - `detectExecutable` fails to find installed CLIs when checking bare names like `'claude'`.
  - Windows executable resolution must check `%PATHEXT%` (`.COM;.EXE;.BAT;.CMD;.VBS;...`).
- Spawning `.cmd` / `.bat` wrappers on Windows via `child_process.spawn` or `execFile` without shell resolution or explicit executable extensions causes `ENOENT` / `EINVAL`.

### 1.7 Application Data Paths

- `src/state/activity.ts` and `desktop/main.mjs` check `process.platform === 'darwin'` (`~/Library/Application Support/Rirei`) and otherwise fall back to `$XDG_DATA_HOME/rirei` or `~/.local/share/rirei`.
- On Windows, persistent application data must be resolved from `%LOCALAPPDATA%\Rirei` (or `process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local', 'Rirei')`).

### 1.8 Sidecar Port Discovery

- `desktop/opencode-lifecycle-wrapper.mjs` runs `/usr/sbin/lsof -nP -a -p <pid> -iTCP -sTCP:LISTEN -Fn` to discover OpenCode's dynamically assigned loopback port.
- This is completely non-portable to Windows.

---

## 2. File-by-File Audit & Incompatibility Matrix

| File                                     | Current Implementation / OS Assumption                                                                                                                                                                                                                                                                                                            | Windows Incompatibility                                                                                                                                                                  | Planned Cross-Platform Replacement                                                                                                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `desktop/pty_bridge.py`                  | `#!/usr/bin/python3`<br>`pty.fork()`, `termios`, `fcntl.ioctl(TIOCSWINSZ)`<br>`ps -axo pid=,ppid=`<br>`SIGUSR1`, `SIGUSR2`, `SIGHUP`, `SIGINT`, `SIGTERM`, `SIGKILL`<br>stdio fd 3 (control) and fd 4 (events)                                                                                                                                    | Python 3 and Unix PTY modules (`pty`, `termios`, `fcntl`) do not exist on Windows.<br>`ps` command missing.<br>POSIX signals unsupported.                                                | Replace entirely with cross-platform `node-pty` terminal host using Windows ConPTY and Unix openpty. Retain raw byte streams, resize events, and daemon ownership.                                            |
| `desktop/terminal-daemon-server.mjs`     | Spawns `/usr/bin/python3` with `pty_bridge.py`<br>`process.umask(0o077)`<br>`chmod(..., 0o700)` / `chmod(..., 0o600)`<br>`lstat().isSocket()`<br>`rm(socketPath)`<br>Socket path: `path.join(runtimeRoot, 'pty-${hash}.sock')`<br>JSON frames over stdio 3                                                                                        | Python bridge cannot run on Windows.<br>Named pipes are not filesystem socket nodes and cannot be checked with `lstat.isSocket()` or removed with `rm()`.<br>Windows `umask` is a no-op. | Integrate direct `TerminalHost` abstraction (`node-pty`).<br>Use `src/platform/terminal-endpoint.ts` to supply `\\.\pipe\rirei-<hash>-pty-v1` on Windows and `.sock` on Unix.<br>Abstract socket preparation. |
| `desktop/terminal-daemon-client.mjs`     | `(descriptorFile.mode & 0o077) !== 0`<br>`process.getuid()` check<br>`net.createConnection(descriptor.socketPath)` assumes Unix socket permissions                                                                                                                                                                                                | Mode bit check triggers false security error on Windows (`0o666`).<br>`process.getuid` is undefined on Windows.                                                                          | Skip POSIX permission bit verification on Windows (or verify NTFS owner when supported).<br>Connect cleanly to Windows named pipes via `net.createConnection(pipePath)`.                                      |
| `desktop/terminal-daemon.mjs`            | Shell fallback: `/bin/zsh -l`<br>PATH fallback: `/usr/bin:/bin:/usr/sbin:/sbin`<br>`child.kill('SIGKILL')` in bridge and status commands                                                                                                                                                                                                          | `/bin/zsh` and `-l` flag do not exist on Windows.<br>Hardcoded Unix PATH fallback.<br>`SIGKILL` does not escalate process termination on Windows.                                        | Use `src/platform/shell.ts` to detect default shell (`pwsh.exe` -> `powershell.exe` -> `cmd.exe` on Windows).<br>Use `path.delimiter` and Windows `%PATH%`.<br>Use cross-platform process termination.        |
| `desktop/main.mjs`                       | `daemonRuntimePaths()` uses Unix socket under `os.tmpdir()` with `process.getuid()`<br>`nodePath()` candidate list: `['/usr/local/bin/node', '/opt/homebrew/bin/node']`<br>`providerPath()` candidate list: `['/opt/homebrew/bin', '/usr/local/bin']`<br>`loginShellPath()` fallback: `/bin/zsh`<br>`globalActivityFile()` checks `darwin` vs XDG | Windows socket path format invalid.<br>Hardcoded macOS PATHs.<br>Missing `%LOCALAPPDATA%` resolution for activity file on Windows.                                                       | Centralize in `src/platform/runtime-paths.ts`, `src/platform/shell.ts`, and `src/platform/executable.ts`.                                                                                                     |
| `desktop/terminal-control.mjs`           | Framing protocol for resize, interrupt, terminate, kill                                                                                                                                                                                                                                                                                           | Protocol is JSON-based and platform-agnostic, but action semantics currently assume POSIX signal mapping.                                                                                | Update action handlers to record explicit `TerminalInterruptIntent` and dispatch cross-platform actions.                                                                                                      |
| `desktop/opencode-lifecycle-wrapper.mjs` | `/usr/sbin/lsof -nP -a -p <pid> -iTCP -sTCP:LISTEN -Fn`<br>`spawn('opencode', ...)`<br>`SIGHUP`, `SIGINT`, `SIGTERM` handlers                                                                                                                                                                                                                     | `/usr/sbin/lsof` does not exist on Windows.<br>`opencode` on Windows is `opencode.cmd` or `opencode.exe`.<br>POSIX signals unsupported.                                                  | Remove `lsof` dependency: launch with explicit pre-assigned candidate port or parse machine-readable startup logs.<br>Resolve executable with `PATHEXT`.                                                      |
| `desktop/codex-lifecycle-wrapper.mjs`    | `spawn('codex', ...)`<br>`stopSidecar()` uses `SIGTERM` and `SIGKILL` timers                                                                                                                                                                                                                                                                      | `codex` on Windows is `codex.cmd` or `codex.exe`.<br>Signal timers do not terminate child process trees on Windows.                                                                      | Resolve executable via `PATHEXT`.<br>Use cross-platform process tree killer (`taskkill /PID <pid> /T /F` on Windows fallback).                                                                                |
| `desktop/provider-lifecycle-hook.cjs`    | `net.createConnection(socketPath)`                                                                                                                                                                                                                                                                                                                | Socket path on Windows must be a named pipe (`\\.\pipe\...`).                                                                                                                            | Net connection works identically for Windows named pipes once named pipe path is passed via `RIREI_LIFECYCLE_SOCKET`.                                                                                         |
| `src/process/inherited-process-host.ts`  | `spawn(request.command.executable, ...)`<br>`child.kill('SIGINT')`, `child.kill('SIGTERM')`                                                                                                                                                                                                                                                       | Calling `spawn('claude', ...)` without resolving `.cmd` or `shell: true` fails on Windows.<br>`kill('SIGINT')` / `kill('SIGTERM')` behavior differs on Windows.                          | Resolve executable via `PATHEXT`.<br>Map interrupts and process-tree termination according to platform.                                                                                                       |
| `src/agents/registry.ts`                 | `detectExecutable()` iterates `PATH` checking `path.join(dir, executable)` and `access(candidate, constants.X_OK)`<br>`execFileAsync(this.executable, ...)`                                                                                                                                                                                       | Does not check extensions in `%PATHEXT%` (`.cmd`, `.bat`, `.exe`), causing false `not_installed` detections on Windows.<br>`access(..., X_OK)` is meaningless on Windows.                | Implement `src/platform/executable.ts` with `findExecutable()` supporting `PATHEXT` and `pathext` iteration on Windows.                                                                                       |
| `src/agents/usage-collectors.ts`         | Embedded shell script in `claudePrepareUsage()` uses POSIX `if [ -n ... ]; then ... fi`<br>Single quotes in command generation: `'${value}'`<br>`constants.O_NOFOLLOW` in `open()`<br>`chmod(..., 0o700)` / `0o600`                                                                                                                               | POSIX shell script syntax and single quotes fail when Claude executes hooks under `cmd.exe` on Windows.<br>`O_NOFOLLOW` is not supported on Windows.                                     | Generate platform-aware hook commands (or run via Node.js directly).<br>Sanitize Windows quotes (`"..."`).<br>Safely guard `O_NOFOLLOW` on `win32`.                                                           |
| `src/application/controller.ts`          | `currentBootId()` uses `hostname() + ':' + Math.round((now - uptime() * 1000) / 60_000)`                                                                                                                                                                                                                                                          | Logic is platform-agnostic, but uptime resolution on Windows should be validated for consistency.                                                                                        | Retain existing logic; verify in Windows CI.                                                                                                                                                                  |
| `src/application/reconciliation.ts`      | `processIsAlive(pid)` uses `process.kill(pid, 0)`                                                                                                                                                                                                                                                                                                 | `process.kill(pid, 0)` works in Node on Windows, but PID recycling and permission handling need cross-platform test coverage.                                                            | Keep `processIsAlive` with platform-specific checks in `src/platform/process-control.ts`.                                                                                                                     |
| `src/state/store.ts`                     | `rename(temporary, destination)` for atomic publish<br>`chmod(..., 0o700)` / `chmod(..., 0o600)`<br>Temporary sweep regexes                                                                                                                                                                                                                       | On Windows NTFS, `rename()` over an existing file fails if another process holds an open handle.                                                                                         | Wrap `rename()` in a bounded retry helper for Windows file locking contention.                                                                                                                                |
| `src/state/journal.ts`                   | `journalFilePath()` uses `activityDataHome()`<br>`mkdir(lock, { mode: 0o700 })` for mutex directory locking                                                                                                                                                                                                                                       | Path must resolve to `%LOCALAPPDATA%\Rirei` on Windows.<br>Directory rename and lock handling must account for Windows error codes (`EEXIST`, `EPERM`, `EACCES`).                        | Use centralized `activityDataHome()` from `src/platform/runtime-paths.ts`.                                                                                                                                    |
| `src/cli/bridge.ts`                      | Command-line bridge options and state updating                                                                                                                                                                                                                                                                                                    | Mostly platform-agnostic CLI handler.                                                                                                                                                    | Keep intact.                                                                                                                                                                                                  |
| `package.json`                           | `launcher:build` uses `osacompile`<br>`install:local` uses `$HOME/.local/bin` and `ln -sf`<br>No `node-pty`, `ink`, or `react` dependencies                                                                                                                                                                                                       | Scripts are macOS/Unix-specific. Missing TUI and PTY dependencies.                                                                                                                       | Add `node-pty`, `ink`, `react` to dependencies.<br>Ensure native binaries are externalized in `esbuild` configuration.<br>Add Windows scripts where appropriate.                                              |

---

## 3. Detailed Technical Replacements

### 3.1 Platform Primitives Architecture (`src/platform/`)

To avoid scattering `process.platform === 'win32'` checks throughout the codebase, create a unified platform module:

1. **`src/platform/runtime-paths.ts`**:
   - `dataHome()`:
     - `RIREI_DATA_HOME` override (if set)
     - `darwin`: `~/Library/Application Support/Rirei`
     - `win32`: `%LOCALAPPDATA%\Rirei` (fallback: `~/AppData/Local/Rirei`)
     - `linux` / other: `$XDG_DATA_HOME/rirei` (fallback: `~/.local/share/rirei`)
   - `runtimeRoot()`: Temporary runtime directory for descriptors and sockets.
   - `daemonDescriptorPath()`: Path to `terminal-daemon-v1.json`.

2. **`src/platform/terminal-endpoint.ts`**:
   - `daemonEndpoint(hash)`:
     - Unix: `path.join(tempDir, `rirei-${uid}-${hash}`, 'pty-v1.sock')`
     - Windows: `\\\\.\\pipe\\rirei-${hash}-pty-v1`
   - `prepareEndpoint(endpoint)`:
     - Unix: Creates directory with `0o700`, cleans up stale `.sock` file after checking liveness.
     - Windows: Named pipe namespace is managed by the OS kernel; validates that no existing server is listening.

3. **`src/platform/executable.ts`**:
   - `resolveExecutable(name, customPath?)`:
     - On Windows: splits `%PATHEXT%` (defaulting to `.COM;.EXE;.BAT;.CMD`), checks candidate paths in `PATH` with each extension, returns the resolved absolute or executable name.
     - On Unix: checks `PATH` entries with `X_OK`.
   - `isExecutableInstalled(name)`: cross-platform boolean check.

4. **`src/platform/shell.ts`**:
   - `defaultInteractiveShell()`:
     - Windows: checks `pwsh.exe` -> `powershell.exe` -> `process.env.COMSPEC` -> `cmd.exe`.
     - Unix: checks `process.env.SHELL` -> `/bin/zsh` -> `/bin/bash` -> `/bin/sh`.
   - `shellSpawnArgs(shellPath)`: returns appropriate flags (e.g. `['-l']` for POSIX login shells, `['-NoLogo']` or empty for PowerShell/cmd).

5. **`src/platform/process-control.ts`**:
   - `processIsAlive(pid)`: checks process existence safely across platforms.
   - `killProcessTree(pid, intent)`:
     - Unix: sends signals (`SIGTERM` -> `SIGKILL`) to process tree from leaves to root.
     - Windows: gracefully attempts interrupt or executes `taskkill /PID <pid> /T /F` as final escalation.

---

### 3.2 Terminal Host Replacement (`node-pty`)

Replace `desktop/pty_bridge.py` with a TypeScript `TerminalHost` interface:

```ts
export interface TerminalHost {
  readonly pid: number;
  write(data: Uint8Array): Promise<void>;
  resize(cols: number, rows: number): void;
  interrupt(intent: TerminalInterruptIntent): Promise<void>;
  terminate(): Promise<void>;
  killTree(): Promise<void>;
  onData(listener: (data: Uint8Array) => void): () => void;
  onExit(listener: (result: TerminalExit) => void): () => void;
}
```

- **Windows Implementation**: Spawns using `node-pty` with ConPTY backend enabled.
- **Unix Implementation**: Spawns using `node-pty` with Unix PTY backend.
- **Compatibility**: During transition, macOS retains a fallback validation path until test parity is 100% verified.

---

### 3.3 OpenCode Port Discovery (Replacing `lsof`)

Replace `/usr/sbin/lsof` in `desktop/opencode-lifecycle-wrapper.mjs`:

- Rather than passing `--port 0` and discovering the port via `lsof`, allocate an available loopback port in Node (`net.createServer() -> listen(0) -> get port -> close()`), then pass `--port <allocatedPort> --hostname 127.0.0.1` to OpenCode.
- Poll `http://127.0.0.1:<port>/global/health` with deadlines and retries until the server reports ready.
- This eliminates the need for any OS-specific port inspection tools.

---

### 3.4 Claude Usage Hook Scripting

Replace POSIX bash syntax in `src/agents/usage-collectors.ts` with cross-platform node invocation:

- Instead of inline bash conditionals, invoke `RIREI_NODE_PATH` directly or generate a lightweight `.cjs` hook script that performs the environment checks in JavaScript before connecting to `RIREI_LIFECYCLE_SOCKET`.
- This ensures 100% reliability under Windows `cmd.exe`, PowerShell, and Unix shells without quoting or syntax incompatibilities.

---

---

## 4. Implementation Phasing & Status

1. **Phase 1: Platform Audit** — Complete (`docs/windows-tui.md`).
2. **Phase 2: Cross-Platform Runtime Primitives** — Complete (`src/platform/` modules for runtime paths, terminal endpoints, executable discovery with `%PATHEXT%`, shell resolution, and process tree termination).
3. **Phase 3: Replace the Python PTY Bridge** — Complete (Native `node-pty` terminal host supporting ConPTY on Windows and Unix PTY).
4. **Phase 4: Cross-Platform Stop Semantics** — Complete (Cross-platform process tree termination via `taskkill` on Windows and traversal/process groups on Unix).
5. **Phase 5: Remove Port-Discovery Dependencies** — Complete (Cross-platform TCP listening port discovery supporting `netstat -ano -p tcp`, macOS `lsof`, and Linux `ss`).
6. **Phase 6: Make the Daemon Launchable from the CLI** — Complete (`relay daemon --internal` and `ensureDaemon` supervisor).
7. **Phase 7: TUI Dashboard** — Complete (`ink` / `react` interactive dashboard with active sessions, plan usage, and hotkey actions).
8. **Phase 8: Native Provider TUI Passthrough** — Complete (Raw terminal mode streaming with `Ctrl+]` escape detachment).
9. **Phase 9: Windows Provider Compatibility** — Complete (Cross-platform Claude hooks, `%PATHEXT%` binary resolution, and ConPTY compatibility).
10. **Phase 10: Windows CI** — Complete (`.github/workflows/ci.yml` matrix covering Windows, macOS, and Linux).
11. **Phase 11: Packaging & Documentation** — Complete (`package.json`, `docs/cli-reference.md`, `README.md`, `docs/windows-tui.md`).

---

## 5. Usage & Operations Guide

### Launching the Dashboard

In Windows Terminal (PowerShell 7 / `cmd.exe`) or any macOS/Linux terminal:

```powershell
relay tui
```

### Dashboard Hotkeys

| Key       | Action                                                         |
| --------- | -------------------------------------------------------------- |
| `c`       | Launch Claude session in current project                       |
| `o`       | Launch Codex session in current project                        |
| `g`       | Launch Gemini session in current project                       |
| `a`       | Launch Antigravity session in current project                  |
| `p`       | Launch OpenCode session in current project                     |
| `s`       | Launch new interactive shell terminal                          |
| `Enter`   | Attach to selected session                                     |
| `↑` / `↓` | Navigate active session list                                   |
| `u`       | Refresh dashboard data & provider plan usage                   |
| `q`       | Quit dashboard (leaves daemon and background sessions running) |

### Detaching from an Attached Session

While attached to any native agent or shell session:

- Press **`Ctrl+]`** (`0x1d`) to cleanly detach and return to the Relay TUI dashboard.
- The agent or shell session continues running undisturbed in the background terminal daemon.

---

## 6. Troubleshooting

- **Named Pipe Permissions (Windows)**: If a client cannot connect, verify `%LOCALAPPDATA%\Rirei\terminal-daemon-v1.json` exists and is readable by the current user.
- **Node-PTY Spawn Failures (Unix)**: If `spawn-helper` fails with permissions errors, ensure `node_modules/node-pty/prebuilds/<platform>-<arch>/spawn-helper` has executable permissions (`chmod +x`). Relay includes automated permission remediation at startup.
- **Missing Provider CLIs**: Run `relay doctor` to verify installed binaries and `%PATH%` resolution. On Windows, npm global CLIs install with `.cmd` or `.exe` extensions, which Relay automatically resolves via `%PATHEXT%`.
