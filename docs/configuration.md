# Configuration

Configuration lives in `.relay/config.json`, created by `relay init` from `defaultConfig`
and validated with Zod on every read (`src/config/schema.ts`, `src/config/loader.ts`). An
invalid or manually corrupted config causes the loading command to fail with a schema error.

## Default file

```json
{
  "schemaVersion": 1,
  "handoff": {
    "maxCharacters": 1200,
    "maxTokens": 300,
    "targetCharacters": 1200,
    "targetTokens": 300,
    "maxChangedFiles": 100,
    "maxErrorLines": 200,
    "includeFullDiff": false
  },
  "checkpoint": {
    "maxPatchBytes": 1000000,
    "maxTestOutputBytes": 200000,
    "maxCount": 20
  },
  "tests": {
    "timeoutSeconds": 600,
    "captureOutput": true,
    "maxStoredOutputBytes": 200000
  },
  "activity": {
    "privacyMode": false
  }
}
```

## Field reference

### `schemaVersion` (literal `1`)

Guards against loading a config written by an incompatible future version.

### `handoff`

| Field              | Type / default  | Honored today?                                                                                                                                                                                                                 |
| ------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `maxCharacters`    | int > 0, `1200` | **Yes** — hard character ceiling for the rendered handoff.                                                                                                                                                                     |
| `maxTokens`        | int > 0, `300`  | **Yes** — estimated at four characters per token; the lower of both configured ceilings wins.                                                                                                                                  |
| `targetCharacters` | int > 0, `1200` | **Yes** — defaulted target ceiling; the effective ceiling is the minimum of `maxCharacters`, `targetCharacters`, and `maxTokens * 4`. Older configs without these fields adopt the 1,200/300 contract without being rewritten. |
| `targetTokens`     | int > 0, `300`  | **Yes** — defaulted target ceiling paired with `targetCharacters`.                                                                                                                                                             |
| `maxChangedFiles`  | int > 0, `100`  | **Yes** — limits verified changed-file entries in the capsule.                                                                                                                                                                 |
| `maxErrorLines`    | int > 0, `200`  | Reserved — no error-log section is emitted yet.                                                                                                                                                                                |
| `includeFullDiff`  | bool, `false`   | Reserved — full diffs stay local; the receiving agent inspects the working tree instead.                                                                                                                                       |

> The reported `estimatedTokens` is a deterministic provider-neutral estimate, never an exact
> provider token count. Lower user-configured ceilings are always preserved; adding target
> fields never raises them.

### `checkpoint`

| Field                | Type / default     | Honored today?                                                       |
| -------------------- | ------------------ | -------------------------------------------------------------------- |
| `maxPatchBytes`      | int > 0, `1000000` | **Yes** — `changes.patch` is truncated to this byte budget.          |
| `maxTestOutputBytes` | int > 0, `200000`  | Reserved — checkpoints do not store captured test output yet.        |
| `maxCount`           | int > 0, `20`      | **Yes** — older checkpoint directories are pruned beyond this count. |

### `tests`

| Field                  | Type / default    | Honored today?                                                        |
| ---------------------- | ----------------- | --------------------------------------------------------------------- |
| `command`              | string (optional) | **Yes** — required by `relay finish --run-tests`.                     |
| `timeoutSeconds`       | int > 0, `600`    | Reserved — the finish test run has no timeout wired yet.              |
| `captureOutput`        | bool, `true`      | Reserved — the finish run inherits stdio and does not capture output. |
| `maxStoredOutputBytes` | int > 0, `200000` | Reserved — pairs with capture, not yet used.                          |

### `activity`

| Field         | Type / default | Honored today?                                                                  |
| ------------- | -------------- | ------------------------------------------------------------------------------- |
| `privacyMode` | bool, `false`  | **Yes** — replaces project, task, and branch labels with generic public values. |

> "Reserved" fields are validated and persisted so the schema is stable, but no code path
> reads them yet. They exist to keep the config format forward-compatible. When you wire one
> up, update the "Honored today?" column here (see the docs preference in the project memory).

## Configuring a test command

`tests.command` is the only field a user commonly needs to set. Add it under `tests`:

```json
"tests": {
  "command": "npm test",
  "timeoutSeconds": 600,
  "captureOutput": true,
  "maxStoredOutputBytes": 200000
}
```

Relay does not auto-detect or run test commands on its own; `relay finish --run-tests` is the
only path that executes it, and only when `command` is present.

## Editing config safely

- Keep `schemaVersion` at `1`.
- All numeric limits must be positive integers; booleans must be real booleans.
- After editing by hand, run any Relay command in the repo — a schema error means the edit
  was rejected and nothing was loaded.

## Machine-wide settings (`rireiDataHome()`)

In addition to repository-level `.relay/config.json`, Rirei stores machine-wide configuration and caches under the user's data directory (resolved via `rireiDataHome()`):

- **macOS**: `~/Library/Application Support/Rirei/`
- **Linux**: `~/.local/share/rirei/` (or `$XDG_DATA_HOME/rirei/`)
- **Windows**: `%LOCALAPPDATA%\Rirei\`

### Token usage opt-in (`token-usage-opt-in.json`)

Stores the user's explicit consent state for machine-wide token analytics:

```json
{
  "optIn": true,
  "updatedAt": "2026-09-24T12:00:00.000Z"
}
```

Manage via `relay usage tokens --opt-in` or `--opt-out`.

### Token usage cache (`token-usage-cache.json`)

Caches 180-day history per agent (`AgentCacheSnapshot`) so standard ranges (7D, 30D, 90D) and preceding equal-length comparison windows are derived dynamically and instantly without subprocess execution. Per-agent directory locks serialize concurrent scans and prevent duplicate executions. If a scan completes within 15 seconds, the cached snapshot is reused. Use `--refresh` on CLI commands or the desktop Refresh button to force a new log scan.

- **Competing refreshes wait.** A refresh that finds another scan of the same agent running waits for it (up to two scan timeouts plus 15 seconds: 75 seconds for most agents, 255 for Antigravity) and then reuses its result. If the other scan still holds the lock after that, the last good snapshot is kept and the rest of the report is returned.
- **One timezone per cache.** Daily totals are grouped in the timezone they were collected in, so the cache records it. A read in a different timezone treats the cache as empty, which makes the dashboard rescan, and a refresh in the new timezone drops snapshots from the old one instead of mixing them.
- **Failed session scans stay unknown.** When ccusage's session listing fails but the daily report succeeds, `sessionCount` is `null` and the report's `sessions` for that agent is `null`, not zero.
