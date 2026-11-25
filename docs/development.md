# Development

## Prerequisites

- Node.js 22.12 or newer (`engines.node >= 22.12.0`).
- `git` on `PATH`.
- A supported native `node-pty` package for the host OS/architecture; Windows uses ConPTY.
- Python at `/usr/bin/python3` only when explicitly exercising the legacy POSIX bridge, not
  for the default integrated terminal. Desktop packaging remains macOS-focused.

## Install

```sh
npm ci
```

## npm scripts

| Script                    | Command                                                   | Purpose                                                                                   |
| ------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `dev`                     | `tsx src/index.ts`                                        | Run the CLI from source, e.g. `npm run dev -- status`.                                    |
| `build`                   | esbuild bundle → `dist/index.cjs`                         | Bundle the CLI entry as CommonJS/node22; native/ESM runtime dependencies remain external. |
| `check`                   | `tsc --noEmit`                                            | Type-check without emitting.                                                              |
| `lint`                    | `eslint desktop src tests eslint.config.js`               | Lint the selected source/test/config surfaces.                                            |
| `format` / `format:write` | `prettier --check` / `--write`                            | Check or apply formatting.                                                                |
| `test`                    | `vitest run`                                              | Run the test suite once.                                                                  |
| `install:local`           | build + symlink                                           | Link `dist/index.cjs` to `~/.local/bin/relay`.                                            |
| `desktop:dev`             | build + `electron desktop/main.mjs`                       | Launch the desktop app against the freshly built CLI.                                     |
| `desktop:build`           | build + `scripts/build-desktop.mjs --mac --publish never` | Package desktop DMG/ZIP without publication.                                              |
| `launcher:build`          | `osacompile …`                                            | Build the AppleScript `Relay Launcher.app`.                                               |

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

Windows installer tests run with `npm run test:installer` (PowerShell 7). CI also runs the
same script under Windows PowerShell 5.1. Commands and environment changes are mocked; the
native installer smoke additionally installs the compiled tarball and runs diagnostics and
uninstall under both shells, with persistent user PATH writes kept in memory. The
test never installs prerequisites or changes the host's persistent PATH. The packed-install
smoke test separately exercises an actual user-prefix install, first-task setup through a
real PTY, reinstall, and uninstall.

## Tests

The experimental continuity feature has a zero-provider fixture check:

```sh
npm run benchmark:continuity
npm run benchmark:handoff
```

`tests/context/` also replays hook histories and exercises fake Claude-to-Codex launches
through both TypeScript and the compiled CLI, so build before running it directly. These
tests do not establish native provider event delivery or continuation-quality improvements.
See [the prototype contract](continuity-prototype.md) for the live pilot's separate budget.

The implementation/decision map is in [architecture](architecture.md),
[architecture decisions](architecture-decisions.md), and the [coverage audit](architecture-audit.md).
M0–M5 milestone notes retain their own as-tested results rather than becoming an assertion that
every later working-copy command passed those same gates.

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
- most CLI implementation bundled into the entry
- `node-pty`, `ink`, `react`, `react/*`, and `yoga-layout` deliberately external
- output `dist/index.cjs`, made executable.

The desktop app, packaged `cli/index.cjs` resource, and `install:local` all consume the same
CLI entry. This is not a standalone executable with no runtime dependencies. Keeping Ink and
React external avoids separate React dispatcher instances; native PTY and Yoga/ESM modules
must resolve from the installation. `package:check` specifically rejects accidental bundled
React. Native install/ASAR-unpacked behavior requires packed smoke checks, not just `tsc`.

## Packaging the desktop app

`electron-builder` config lives in `package.json` under `build`:

- `files`: `desktop/**/*` and `package.json` (this includes `renderer/vendor/`).
- `files` explicitly excludes Python `__pycache__`, `.pyc`, and `.pyo` artifacts.
- `asarUnpack`: exposes the detached terminal-daemon entry and static import closure plus
  `pty_bridge.py`, because Node and Python execute those files outside `app.asar`.
- `extraResources`: copies `dist/index.cjs` to `cli/index.cjs`, exactly matching `cliPath()`.
- `mac.target`: `dmg` and `zip`.

The npm CLI package is deliberately smaller than the desktop bundle. The top-level `files`
allowlist includes the bundled CLI, license/readme files, and the three lifecycle helpers needed
by packed daemon launches (`provider-lifecycle-hook.cjs`, `codex-lifecycle-wrapper.mjs`, and
`opencode-lifecycle-wrapper.mjs`), plus the Windows installer and installation guide.
`npm run package:check` enforces that exact allowlist and fails
if local state, source trees, tests, unrelated desktop assets, private keys, or local user paths
enter the tarball.

The extended architecture/decision/audit guides are repository documentation, not an expansion
of the minimal CLI package allowlist. Generated root `ARCHITECTURE*.md` tool reports and local
sync duplicates are not inputs to the release artifact or canonical architecture authority.

## Keeping docs in sync

Documentation is treated as part of each change: when you alter behavior, update the relevant
file in `docs/` (and the root `README.md` if the change is user-facing) in the same commit.
Watch for the "Honored today?" / "Current limitation" / "not yet implemented" notes scattered
through these docs — when you implement one of those, flip the note.

Use [architecture-audit.md](architecture-audit.md) as the source-to-document coverage ledger.
For a changed boundary, update its mechanism, rationale/tradeoff, source/test reference, storage
or protocol version, and shipped/experimental qualification. Label reconstructed rationale rather
than inventing a historical approval. For documentation-only changes, check the touched Markdown,
local links/anchors and referenced source paths; an old runtime test result is not a newly run test.
