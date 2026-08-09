# Relay documentation

Relay preserves provider-independent coding-task state so a developer can move one task
between officially installed coding-agent CLIs (Claude Code, Codex, Gemini) without losing
context or exposing credentials.

This directory documents how Relay actually behaves today. Where the implementation is
intentionally conservative or a configuration value is reserved for future use, the docs
say so explicitly rather than describing aspirational behavior.

## Contents

| Document                                                 | What it covers                                                                     |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [architecture.md](architecture.md)                       | Module layout, data flow, and how a command executes end to end.                   |
| [cli-reference.md](cli-reference.md)                     | Every `relay` command, its options, and exact behavior.                            |
| [configuration.md](configuration.md)                     | `.relay/config.json` schema, defaults, and which fields are honored vs. reserved.  |
| [state-and-events.md](state-and-events.md)               | The `RelayState` schema, migrations, atomic writes, and activity projection.       |
| [checkpoints-and-handoff.md](checkpoints-and-handoff.md) | Checkpoint contents, size bounding, and the handoff format.                        |
| [agents.md](agents.md)                                   | The adapter contract, executable/exit detection, and how to add an adapter.        |
| [desktop.md](desktop.md)                                 | The Electron app, the integrated xterm.js terminal, and the PTY bridge.            |
| [security.md](security.md)                               | Authentication boundary, Git safety rules, path policy, and secret handling.       |
| [approval-protocol.md](approval-protocol.md)             | Versioned local permission-decision boundary and provider activation requirements. |
| [development.md](development.md)                         | Building, testing, linting, packaging, and the source tree.                        |
| [publication.md](publication.md)                         | Licensing, package checks, history cleanup, and release gates.                     |
| [changelog.md](changelog.md)                             | User-visible implementation and documentation changes.                             |

## Quick orientation

- The **repository and `.relay/` state files are the durable source of truth.** Relay never
  transfers hidden reasoning, raw conversations, or provider tokens between agents.
- Relay **owns** task orchestration, checkpointing, handoff generation, and local history.
- Each **provider CLI owns** its own authentication, billing, rate limits, and permissions.
- Relay **never** commits, pushes, resets, merges, or discards repository changes.

For a task-by-task walkthrough, start with [cli-reference.md](cli-reference.md).
