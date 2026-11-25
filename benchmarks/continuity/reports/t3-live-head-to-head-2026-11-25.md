# Live head-to-head: Rirei and T3 Code

**2026-11-25. Both passed on the partner-export task and produced byte-identical code.** T3 Code
finished sooner and used fewer tools in this pair. Rirei reported lower non-cached usage.

| Measurement                                    |  T3 Code |    Rirei |
| ---------------------------------------------- | -------: | -------: |
| Held-out acceptance                            |     Pass |     Pass |
| Receiver ran the public test on the final code |     Pass |     Pass |
| Operator follow-ups                            |        0 |        0 |
| Measured continuation                          | 18.449 s | 32.974 s |
| Recorded tool calls                            |        3 |        6 |
| Total input tokens                             |   65,706 |  107,730 |
| Cached input tokens                            |   48,768 |  102,400 |
| Output tokens                                  |      593 |    1,099 |
| Non-cached input plus output                   |   17,531 |    6,429 |

## What happened

T3 Code supplied the exact label in its injected history before the Codex turn. Codex inspected
the workspace, edited the export, and ran the public test without requesting history. Rirei
supplied a citation. Its receiver read a task page that repeated already-inline instructions,
then fetched the missing label in a bounded 1,070-byte evidence response. It inspected the
workspace, made the same edit, and ran the public test plus a direct compatibility assertion.

The independent grader checked the exact label, ID preservation on two held-out inputs with
decoy `key` values, and unchanged provided files. Each receiver's passing public test printed
the SHA-256 of the final implementation bytes. Both matched the on-disk file after the run.

## Matched setup and limits

- Two authorized live receiver launches, one per product, each capped at 180 seconds. T3 Code
  ran first. No retries or live predecessor runs.
- Codex CLI `0.166.0`, requested `gpt-5.6-sol` at low effort on both arms. Rirei used its compiled
  handoff and Codex exec; T3 Code `v0.1.10` used its managed provider switch and Codex App Server.
  Both used workspace-write with tool networking disabled. T3 used on-request approvals;
  Rirei used `never`. Neither run needed an approval.
- Both workspaces had the same Git baseline and interrupted files. Each product had access to
  the original request, correction, failed probe output, and evidence of the older passing
  test and subsequent edit. Rirei rendered the receipt as stale; T3's predecessor history was
  recorded by a local replay provider inside its managed thread so the probe output survived.
  See the [offline import and handoff preflight](t3-handoff-preflight-2026-11-25.md).
- Continuation time excludes fixture and history setup. T3 timing started at its switch and
  ended at the observed Codex turn completion. Rirei timing added CLI rendering to its
  launch-through-trace-finalization span. The endpoints are specific to the two harnesses.
- Non-cached usage is reported input minus cached input plus output. Cache state was not
  controlled, and the arms used different prompt and tool surfaces. A single pair cannot
  establish why cache reuse differed, general speed or quality, or a billing advantage.

## Evidence identifiers

- Interrupted checkpoint: `b75fad3650148e1b18ec7460f9100a624de48682340ad9826f8e2a89bf2f70f8`.
- Failed probe text: `430abfaa18a4bee08a659dc25164144fe158a2e8e4d337a82803153331fbb469`.
- Final implementation in both arms: `81f41c5d9ff128399d17ddc28798a74f8a354960e0b2a49bb166d81cc1505067`.
- T3 provider trace: `39532af637dcfa737ed268f8ec1b6b3e0ce65922da8d47479d2a751f9c776180`.
- Rirei provider trace: `7bf183d026cb9af61fef399d77a538a7d4d30472135c1328a8ea399f77e40c0a`.
