# Relay Threads

Relay Threads provides local, task-scoped coordination between Rirei-managed runs and the human operator. It stores bounded message envelopes without copying provider credentials, writing to provider PTYs, or treating messages as system instructions.

## Storage and identity

- The authority is `.relay/threads/<sha256(sessionId)>.json` in the primary Git worktree.
- Linked worktrees resolve that primary authority through Git's common directory.
- Updates hold `.relay/threads.lock`, validate strict schemas, increment a monotonic revision, write a private temporary file, fsync it, rename it, and fsync the containing directory.
- Reads and writes reject symlinked or non-regular Relay, Threads, journal, and capability paths.
- Routing accepts only `operator` and active canonical `run:<run-id>` references. Display labels are non-unique presentation aliases and never route messages.
- Operation IDs provide conflict-detecting idempotency. Reusing an ID with a different semantic payload fails.

## Security model

Each managed run receives a 256-bit ephemeral message token through its environment. Relay persists only the SHA-256 digest in `.relay/runtime/message-capabilities/<sha256(runId)>.json`.

Run authentication fails closed when capability variables are missing or inconsistent. Validation binds the token to the primary project root, task session, active non-orphaned run lease, and terminal when one exists. The descriptor is revoked as soon as run finalization begins.

Operator commands are local same-user commands outside a managed-run environment. Relay is not an operating-system sandbox: provider processes execute with the user's filesystem permissions. Do not run an untrusted provider binary merely because Threads authentication is enabled.

Before persistence, Relay rejects recognized secrets unless `--redact` is explicit. Message output escapes terminal, bidi, and malformed control content and frames bodies as untrusted user-level context. Bodies are excluded from daemon notifications, global activity, native notifications, and terminal lifecycle journals.

## Delivery support

All current adapters support durable manual inbox delivery:

```sh
relay message inbox
```

`next_safe_turn` and `wake` remain reserved schema values, but current adapters advertise both as unsupported. CLI requests fail, and desktop/TUI controls remain unavailable. Relay does not silently fall back or claim delivery. Automated delivery may be enabled only after a documented official provider interface and fixture-backed tests exist.

Inbox messages begin as `queued`. Reading sets `readAt` without claiming provider-context delivery. Explicit acknowledgement sets `acknowledgedAt`; ending the recipient or closing the task expires remaining queued messages. `delivered` fields are reserved for a future verified adapter integration.

## Limits

- Body: 8 KiB UTF-8.
- Combined context cards: 16 KiB UTF-8, up to three cards.
- Complete message/rendered envelope: 32 KiB UTF-8.
- Journal: 100 threads, 1,000 messages, and 5 MiB.
- CLI body input must use exactly one of `--text` or `--stdin`; stdin is bounded while streaming and decoded as strict UTF-8.

## Commands

```sh
relay message peers [--json]
relay message preview --to run:<id> (--text <body> | --stdin) [--redact]
relay message send --to run:<id> (--text <body> | --stdin) [--intent request|inform]
relay message inbox [--unread] [--peek] [--json]
relay message threads [--filter <text>] [--json]
relay message thread <thread-id> [--json]
relay message reply <message-id> (--text <body> | --stdin) [--intent request|inform|ack]
relay message read <message-id> [--json]
relay message acknowledge <message-id> [--json]
relay session label run:<id> <display-label> [--json]
```

Only the operator can rename labels. Runs can send as themselves, inspect participating threads, read messages addressed to them, and acknowledge messages addressed to them. Operators can inspect all current-task threads.

Desktop and terminal dashboards expose unread attention, thread list/detail, inbox-only composition and replies, context cards, receipt metadata, and active-session capability labels. Daemon fanout carries only project/session/thread/message identifiers and revision metadata to clients watching the matching project.
