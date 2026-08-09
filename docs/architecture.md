# Architecture

Relay is a TypeScript CLI (bundled with esbuild, run on Node.js 22.12+) plus an optional
Electron desktop shell that wraps the same CLI. This document explains the module layout
and how a command flows from invocation to state on disk.

## Source tree

```
src/
├── index.ts              # Commander entrypoint; registers every command
├── lifecycle.ts          # Task context, checkpoints, handoffs, CLI launch wrapper
├── application/
│   └── sessions.ts       # Shared SessionManager: leases, process ownership, finalization
├── process/
│   ├── process-host.ts   # Frontend-independent ProcessHost contract
│   └── inherited-process-host.ts # Scriptable CLI implementation
├── cli/                  # One file per command; thin wrappers over lifecycle + state
│   ├── init.ts  start.ts  status.ts  checkpoint.ts  handoff.ts
│   └── run.ts   switch.ts finish.ts   doctor.ts
├── agents/
│   ├── adapter.ts        # AgentAdapter interface and result types
│   └── registry.ts       # OfficialCliAdapter + the claude/codex/gemini registry
├── config/
│   ├── schema.ts         # Zod config schema + defaultConfig
│   └── loader.ts         # readConfig / writeConfig
├── state/
│   ├── schema.ts         # Zod RelayState and RunLease schemas
│   ├── store.ts          # locked/revisioned atomic state mutations
│   ├── lock.ts           # repository writer lock
│   ├── leases.ts         # one-writer-per-worktree invariants
│   ├── migrations.ts     # ordered persistent state migrations
│   ├── activity.ts       # global sanitized activity snapshot
│   └── events.ts         # compatibility projection hook
├── git/
│   └── repository.ts     # discoverRepository, inspectGitBaseline, inspectGitSnapshot
└── safety/
    └── path-policy.ts    # relayPath: confines all writes to .relay/

desktop/                  # Electron shell (see desktop.md)
tests/                    # Vitest suites mirroring src/
```

## Layers

1. **Command layer (`src/cli/*`)** — each command is a `commander` `Command`. It parses
   arguments, resolves the repository, and calls into `lifecycle.ts` or the state/store
   helpers. Commands avoid business logic beyond argument handling and output formatting.

2. **Application layer (`desktop/terminal-manager.mjs` & `src/application/sessions.ts`)** —
   `TerminalManager` limits concurrency to 4 active terminals. It retains outputs per-tab.
   `SessionManager` owns provider command preparation, durable run identity, worktree leases,
   process-host handles, controls, and one-time finalization. It depends on the typed
   `ProcessHost` contract rather than CLI, Electron, or a particular PTY implementation.

3. **Lifecycle layer (`src/lifecycle.ts`)** — the shared operations that multiple commands
   need:
   - `taskContext()` — discover the repo, load state, and assert the task is `active` or
     `blocked`. Used by `checkpoint`, `handoff`, `run`, `switch`, and `finish`.
   - `createCheckpoint()` — snapshot Git and write a bounded checkpoint directory.
   - `renderHandoff()` — build the compact, provider-independent handoff text.
   - `launchAgent()` — compatibility wrapper that runs `SessionManager` with
     `InheritedProcessHost` and waits for completion.

4. **Process-host layer (`src/process/*`)** — owns process handles and implements typed
   start/write/resize/interrupt/stop/subscribe operations. The current CLI host inherits stdio;
   deterministic fake hosts exercise session behavior without real providers.

5. **Domain layer** — `state/`, `config/`, `git/`, and `agents/` are the primitives:
   validated persistence, Git inspection, and the provider adapters.

6. **Safety layer (`src/safety/path-policy.ts`)** — every path that Relay writes is passed
   through `relayPath()`, which resolves it and throws if it would escape `.relay/`.

## Data flow: `relay switch codex`

```
switch.ts
  └─ taskContext()                     # load + validate active task
  └─ createCheckpoint(root, state, "Switch to codex")
        ├─ readConfig()                # size limits
        ├─ inspectGitSnapshot()        # status, diff --stat, bounded diff --binary
        ├─ write .relay/checkpoints/<id>/{metadata,status,diff-stat,changes.patch}
        ├─ prune checkpoints beyond maxCount
        ├─ writeState()                # atomic temp-file + rename
        └─ appendEvent("checkpoint_created")
  └─ renderHandoff(root, state)        # compact text from structured state
  └─ launchAgent(root, state, codexAdapter, handoff)
        └─ SessionManager.startRun(...)
         ├─ adapter.detectInstallation()  # must be "ready"
         ├─ updateState() + appendEvent("agent_started") # operation ID + run lease
         ├─ InheritedProcessHost.start(...) # provider with inherited stdio
         ├─ adapter.classifyExit(result)
         └─ updateState() + appendEvent("agent_ended") # one-time lease release
```

`SessionManager` stores explicit model and effort selections on the run record before spawning
the CLI. On exit it re-reads the latest state and updates the matching stable run ID with the
end time, exit code, and classified reason. `relay status --json` returns this chronological
history, and Rirei renders it newest-first without maintaining a second desktop-only store.

Callers may supply an operation ID. Relay derives a stable run ID from the task session and
operation ID, so retrying a launch cannot spawn a second provider even after the bounded
operation ledger rotates. A completed retry returns the durable result; an uncertain active
retry returns `RunAlreadyStartedError`.

The same `createCheckpoint` / `renderHandoff` / `launchAgent` primitives back `run`,
`checkpoint`, `handoff`, and `finish`, which keeps behavior consistent across commands.

## Persistence model

- **`.relay/state.json`** — the single source of structured task state. Written atomically
  (write to a temp file, then `rename` over the target) so an interrupted process never
  leaves a half-written file. See [state-and-events.md](state-and-events.md).
- **`~/Library/Application Support/Rirei/activity.json`** — bounded, sanitized, cross-project session snapshot for read-only companion surfaces.
- **`.relay/config.json`** — validated configuration. See [configuration.md](configuration.md).
- **`.relay/checkpoints/<id>/`** — per-checkpoint snapshots. See
  [checkpoints-and-handoff.md](checkpoints-and-handoff.md).

All of these live under `.relay/`, created with restrictive permissions (`0700` for
directories, `0600` for files).

## Design principles reflected in the code

- **Deterministic over inferred.** Repository facts come from `git` invoked with argument
  arrays (never shell string interpolation), not from an LLM.
- **Conservative reporting.** When Relay cannot determine something safely (authentication
  status, exit reason), it reports `unknown` rather than guessing. See [agents.md](agents.md).
- **Read-only on your repo.** Relay inspects Git but never mutates history or the working
  tree. See [security.md](security.md).
