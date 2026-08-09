# Configuration

Configuration lives in `.relay/config.json`, created by `relay init` from `defaultConfig`
and validated with Zod on every read (`src/config/schema.ts`, `src/config/loader.ts`). An
invalid or manually corrupted config causes the loading command to fail with a schema error.

## Default file

```json
{
  "schemaVersion": 1,
  "handoff": {
    "maxCharacters": 24000,
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

| Field             | Type / default   | Honored today?                                                                                       |
| ----------------- | ---------------- | ---------------------------------------------------------------------------------------------------- |
| `maxCharacters`   | int > 0, `24000` | **Yes** — `renderHandoff` truncates output to this length with a `[Relay handoff truncated]` marker. |
| `maxChangedFiles` | int > 0, `100`   | Reserved — not yet enforced in the handoff.                                                          |
| `maxErrorLines`   | int > 0, `200`   | Reserved — no error-log section is emitted yet.                                                      |
| `includeFullDiff` | bool, `false`    | Reserved — the handoff always excludes the full diff regardless of this flag.                        |

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
