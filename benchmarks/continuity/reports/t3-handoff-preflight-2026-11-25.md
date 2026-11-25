# T3 Code handoff preflight: partner export

**2026-11-25.** The standalone [T3 Code v0.1.10](https://github.com/pingdotgg/t3code/releases/tag/v0.1.10)
server started on Apple Silicon and served its web page. Its built-in provider switch delivered
the exact export label when the failed tool result had been recorded inside a T3-managed thread.
Importing the same history as a saved Claude transcript dropped that tool result.

## Evidence delivered to the receiver

| Starting point in T3 Code                                 | Original request and late correction | Failed probe output with exact label                               |
| --------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------ |
| Import a synthetic saved Claude transcript                | Both delivered                       | Absent from the imported thread and receiver input                 |
| Record the same messages and probe in a T3-managed thread | Both delivered                       | Delivered intact in the injected history before the receiving turn |

Both copies began with the three workspace files from the
[Rirei lookup fixture](lookup-live-2026-11-18.md). Their bytes matched the original interrupted
checkpoint hash. The original request, correction, and failed probe output came from that
fixture's retained evidence. Neither the files nor the user messages contained the exact label.

The import used T3's saved-session scanner and importer on a synthetic Claude JSONL file. The
managed thread used a local mock ACP provider to report the tool result. Both switches used the
server commands for setting the provider and sending the next message. A mock Codex App Server
recorded the actual requests T3 sent, including `thread/inject_items` and `turn/start`.

## What this establishes

The T3-managed setup preserves the evidence needed for this fixture. The saved-session import
alone would give the T3 receiver less information than Rirei received. For a matched live test,
prepare a T3-managed thread and verify that the correction, the failed probe output, and the
pre-edit verification evidence are available in both arms before starting Codex.

**Zero live provider sessions.** This test checked evidence delivery with mock providers; it did
not measure task completion, verification behavior, token usage, or elapsed time for a live T3
receiver.

## Run identifiers

- Official Apple Silicon archive SHA-256:
  `771e5a209ffa881e409ab3b3d39500dbd57e1176aaa49de81ce07bb3e62d5ee8`.
- Interrupted checkpoint SHA-256:
  `b75fad3650148e1b18ec7460f9100a624de48682340ad9826f8e2a89bf2f70f8`.
- Mock receiver wire log SHA-256:
  `85021981edb8f2b3da6e3fe5b3e31a219efdceafcd90e275e42f0e9e84ae204a`.
