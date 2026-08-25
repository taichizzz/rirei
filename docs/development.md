# Development

## Prerequisites

- Node.js 22.12 or newer (`engines.node >= 22.12.0`).
- `git` on `PATH`.
- macOS with `/usr/bin/python3` for the desktop integrated terminal (system Python is fine).

## Install

```sh
npm install
```

## npm scripts

| Script                    | Command                           | Purpose                                                                       |
| ------------------------- | --------------------------------- | ----------------------------------------------------------------------------- |
| `dev`                     | `tsx src/index.ts`                | Run the CLI from source, e.g. `npm run dev -- status`.                        |
| `build`                   | esbuild bundle → `dist/index.cjs` | Bundle a self-contained CLI (CommonJS, node22 target) and mark it executable. |
| `check`                   | `tsc --noEmit`                    | Type-check without emitting.                                                  |
| `lint`                    | `eslint .`                        | Lint the project.                                                             |
| `format` / `format:write` | `prettier --check` / `--write`    | Check or apply formatting.                                                    |
| `test`                    | `vitest run`                      | Run the test suite once.                                                      |
| `install:local`           | build + symlink                   | Link `dist/index.cjs` to `~/.local/bin/relay`.                                |
| `desktop:dev`             | build + `electron .`              | Launch the desktop app against the freshly built CLI.                         |
| `desktop:build`           | build + `electron-builder --mac`  | Package the desktop DMG/ZIP.                                                  |
| `launcher:build`          | `osacompile …`                    | Build the AppleScript `Relay Launcher.app`.                                   |

## Typical loops

Run a command from source:

```sh
npm run dev -- init
npm run dev -- start "Add OAuth login"
npm run dev -- status
```

Before committing:

```sh
npm run verify
npm run audit:production
npm run package:check
```

## Tests

Vitest suites live under `tests/`, mirroring `src/`:

```
tests/
├── application/               # shared session manager and fake process hosts
├── cli/                       # lifecycle and structured CLI behavior
├── desktop/                   # IPC models, deep links, activity, usage, approval protocol
├── state/                     # locking, migrations, leases, publication, concurrency
├── worktrees/                 # isolated workspace creation and cleanup inspection
└── helpers.ts                 # temporary Git repository fixtures
```

The lifecycle suite creates real temporary Git repositories, so tests exercise actual `git`
behavior rather than mocks. Add tests alongside the module you change; for adapters, prefer
fixture-based tests over live CLI calls.

## Linting notes

`eslint.config.js` (flat config) ignores build artifacts and vendored code:

- `dist/`, `coverage/`, `release/` — generated output.
- `desktop/renderer/vendor/` — the vendored xterm bundle.

The Electron files (`desktop/**/*.{mjs,cjs,js}`) get a Node globals block (`process`,
`module`, `__dirname`, `console`) and have `@typescript-eslint/no-require-imports` disabled,
since `preload.cjs` legitimately uses CommonJS `require`. The browser renderer declares its
globals (`window`, `document`, `Terminal`, `FitAddon`, …) with a `/* global */` comment.

## Building the CLI

`npm run build` bundles `src/index.ts` with esbuild:

- `--platform=node --format=cjs --target=node22`
- production dependencies bundled into the artifact
- output `dist/index.cjs`, made executable.

The desktop app, packaged `cli/index.cjs` resource, and `install:local` all consume the same
self-contained artifact.

## Packaging the desktop app

`electron-builder` config lives in `package.json` under `build`:

- `files`: `desktop/**/*` and `package.json` (this includes `renderer/vendor/`).
- `files` explicitly excludes Python `__pycache__`, `.pyc`, and `.pyo` artifacts.
- `asarUnpack`: exposes the detached terminal-daemon entry and static import closure plus
  `pty_bridge.py`, because Node and Python execute those files outside `app.asar`.
- `extraResources`: copies `dist/index.cjs` to `cli/index.cjs`, exactly matching `cliPath()`.
- `mac.target`: `dmg` and `zip`.

The npm source package is deliberately smaller than the desktop bundle. The top-level `files`
allowlist includes only the bundled CLI and required license/readme files. `npm run
package:check` fails if local state, source trees, tests, desktop assets, private keys, or local
user paths enter that tarball.

## Keeping docs in sync

Documentation is treated as part of each change: when you alter behavior, update the relevant
file in `docs/` (and the root `README.md` if the change is user-facing) in the same commit.
Watch for the "Honored today?" / "Current limitation" / "not yet implemented" notes scattered
through these docs — when you implement one of those, flip the note.
