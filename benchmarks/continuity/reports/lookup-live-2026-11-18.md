# Live lookup-dependent handoff smoke

**Passed, 2026-11-18.** A fresh Codex receiver recovered the required label from the cited
record, implemented the correction, and checked the resulting code without operator follow-up.
The run used its single authorized launch with a 180-second cap and zero retries.

## What the receiver got

The partner-export fixture started from a partial implementation and authored predecessor
history. The normal handoff included the late correction and the evidence citation, but the
exact label occurred only in the retained compatibility-probe result. A public test had passed
before a source edit; the handoff marked that receipt stale. The checkpoint failed the
held-out acceptance check before the receiver started.

The run used Codex CLI **0.166.0** with requested model **`gpt-5.6-sol`**, low effort. The
provider did not report a resolved model identifier.

## Observed result

| Gate                                    | Result                                                                                                                     |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Lookup through the pinned helper        | Pass. `/bin/zsh -lc` ran the explicit helper and returned the correct cited record in one bounded read (1,074 bytes).      |
| Held-out acceptance                     | Pass. The final export preserved both held-out input IDs and returned the exact label from the record.                     |
| Fresh verification by the receiver      | Pass. The receiver ran the public test after editing. Its reported source checksum matched the final implementation bytes. |
| Evidence, helper, and fixture integrity | Pass. Protected inputs and the pinned build matched their pre-run hashes.                                                  |
| Execution and trace                     | Exit 0, complete persisted trace, no timeout.                                                                              |

The evidence lookup completed **11.704 s** after launch. The fresh public check completed at
**29.382 s**, and the receiver exited at **34.608 s**. Codex also fetched a task page that
repeated the two already-inline submissions; only the distinct cited evidence read supplied
the missing label. It made six recorded tool calls in total.

Codex reported **106,789 input tokens**, including **101,504 cached**, and **1,017 output tokens**.
Non-cached input plus output was **6,302 tokens**. These are observations from one run.

## Evidence and scope

This is a one-case live receiver result. It uses the same fixture as the offline rehearsal,
with a public-test checksum to establish exactly which implementation was tested. The retained
history was authored from fixture data. A T3 Code comparison and a live predecessor are outside
this run's scope.

The run directory retains the one-attempt ledger, frozen protocol, compiled CLI, tested source
and driver copies, handoff, visible stream, and grading analysis. The compiled CLI SHA-256 is
`557380fb885fcc91ea6c1dc78f66772636e719b047976d4afd004384558122b2`. The visible trace SHA-256 is
`eab332c7c10d76674e4c7fdf97010b6e3e0a66a7db837ac1b6ae7b2bfa6e2fe1`.
