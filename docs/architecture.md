# Architecture

Relay is a TypeScript CLI (bundled with esbuild, run on Node.js 22+) plus an optional
Electron desktop shell that wraps the same CLI. This document explains the module layout
and how a command flows from invocation to state on disk.

## Source tree

```
src/
├── index.ts              # Commander entrypoint; registers every command
├── lifecycle.ts          # Shared task operations: taskContext, createCheckpoint,
│                         #   renderHandoff, launchAgent
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
│   ├── schema.ts         # Zod RelayState schema
│   ├── store.ts          # readState / writeState (atomic)
│   └── events.ts         # appendEvent (events.jsonl)
├── git/
│   └── repository.ts     # discoverRepository, inspectGitBaseline, inspectGitSnapshot
└── safety/
    └── path-policy.ts    # relayPath: confines all writes to .relay/

desktop/                  # Electron shell (see desktop.md)
tests/                    # Vitest suites mirroring src/
```

> Note: the source tree is flatter than the aspirational layout in the original project
> brief. There is deliberately no separate `handoff/`, `process/`, `tests/` (runtime),
> or `migrations.ts` module yet — that logic lives in `lifecycle.ts`, `git/repository.ts`,
> and the adapter. New modules should be split out only when they earn their own surface.

## Layers

1. **Command layer (`src/cli/*`)** — each command is a `commander` `Command`. It parses
   arguments, resolves the repository, and calls into `lifecycle.ts` or the state/store
   helpers. Commands avoid business logic beyond argument handling and output formatting.

2. **Lifecycle layer (`src/lifecycle.ts`)** — the shared operations that multiple commands
   need:
   - `taskContext()` — discover the repo, load state, and assert the task is `active` or
     `blocked`. Used by `checkpoint`, `handoff`, `run`, `switch`, and `finish`.
   - `createCheckpoint()` — snapshot Git and write a bounded checkpoint directory.
   - `renderHandoff()` — build the compact, provider-independent handoff text.
   - `launchAgent()` — spawn a provider CLI with inherited stdio and record the run.

3. **Domain layer** — `state/`, `config/`, `git/`, and `agents/` are the primitives:
   validated persistence, Git inspection, and the provider adapters.

4. **Safety layer (`src/safety/path-policy.ts`)** — every path that Relay writes is passed
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
        ├─ adapter.detectInstallation()  # must be "ready"
        ├─ writeState() + appendEvent("agent_started") # run ID + session profile
        ├─ spawn("codex", [prompt], { stdio: "inherit" })
        ├─ adapter.classifyExit(result)
        └─ writeState() + appendEvent("agent_ended")   # same run ID + result
```

`launchAgent` stores explicit model and effort selections on the run record before spawning
the CLI. On exit it re-reads the latest state and updates the matching stable run ID with the
end time, exit code, and classified reason. `relay status --json` returns this chronological
history, and Rirei renders it newest-first without maintaining a second desktop-only store.

The same `createCheckpoint` / `renderHandoff` / `launchAgent` primitives back `run`,
`checkpoint`, `handoff`, and `finish`, which keeps behavior consistent across commands.

## Persistence model

- **`.relay/state.json`** — the single source of structured task state. Written atomically
  (write to a temp file, then `rename` over the target) so an interrupted process never
  leaves a half-written file. See [state-and-events.md](state-and-events.md).
- **`.relay/events.jsonl`** — append-only audit log, one JSON object per line.
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
