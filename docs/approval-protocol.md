# Permission approval protocol

Rirei permission approval is intentionally split into two independent boundaries:

1. A provider adapter captures a structured pending request from an official provider hook
   or protocol.
2. A trusted local companion submits a human decision to Rirei.

This document specifies the second boundary. The decision channel is not activated yet.
Rirei does install or host passive lifecycle observers, but they report only normalized status
and cannot submit a permission or question response.

## Security model

- Bind an ephemeral HTTP server only to `127.0.0.1`.
- Generate a new 256-bit bearer token when Rirei starts.
- Atomically write the channel descriptor with mode `0600` under the Rirei application data
  directory. The directory remains mode `0700`.
- Reject non-loopback descriptor URLs, invalid bearer headers, unexpected origins, oversized
  bodies, unknown fields, unsupported schema versions, and expired requests.
- Bind every request to a Rirei terminal UUID and its owning provider run.
- Permit only `allow_once` and `deny`. Persistent grants and bypass modes are not part of
  protocol version 1.
- Resolve each request at most once. Duplicate, cross-terminal, replayed, or late decisions
  fail closed.
- Cancel pending requests when their terminal exits, the provider disconnects, or Rirei
  shuts down.
- Keep provider request details in memory. Do not put commands, paths, prompts, diffs, or
  decisions in `activity.json`, Relay state, searchable history, logs, or notifications.
- Never expose a generic terminal-input, command-execution, or provider-protocol forwarding
  endpoint.

The validated data model and lifecycle store are implemented in
`desktop/approval-protocol.mjs`. They are transport-independent and do not start a server.

## Channel descriptor

The future descriptor contains exactly:

```json
{
  "schemaVersion": 1,
  "baseURL": "http://127.0.0.1:49152",
  "token": "<43-character base64url token>",
  "pid": 12345,
  "startedAt": "2026-08-09T00:00:00.000Z"
}
```

Clients must open this file without following symbolic links and validate the exact schema
before making a request. Every request uses `Authorization: Bearer <token>`.

## Pending request

Pending requests contain a request UUID, terminal UUID, supported provider, bounded title and
display details, category, creation/expiry times, and the fixed decisions
`["allow_once", "deny"]`. Expiry may not exceed five minutes.

Display details can contain sensitive commands or paths needed for an informed decision.
They are transient, bounded, rendered as plain text, and never copied into the read-only
activity feed.

## Provider activation

- **Claude:** generated per-launch settings use official `PermissionRequest` and
  `PreToolUse`/`AskUserQuestion` hooks to report `needs_permission` or `waiting_for_input` to
  the owning terminal. The hook intentionally emits no decision. A future decision channel
  may extend this boundary without changing provider-global settings.
- **Codex:** Rirei hosts `codex app-server` on a random, capability-token-authenticated loopback
  WebSocket and attaches the native TUI through `--remote`. A second authenticated connection observes
  `thread/status/changed` passively and never answers an app-server request.
- **Gemini:** use ACP `session/request_permission`; native PTY output is not sufficient.
- **Antigravity:** no verified structured approval interface is currently available, so it
  remains terminal-only.
- **OpenCode:** the native TUI hosts a random-password loopback server. Rirei observes
  authenticated SSE events and reconciles pending permission/question state through bounded
  read-only REST requests. It never enables `--auto` or calls a reply endpoint.

Terminal-output scraping and simulated approval keystrokes are prohibited because output can
be spoofed, split, stale, or no longer associated with the visible prompt.
