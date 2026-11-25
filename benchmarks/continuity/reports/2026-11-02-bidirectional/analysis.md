# Real two-way successor pilot

Experiment launches: 12 (4 predecessors + 8 receivers). Including the prior failed authentication launch: 13.

| Direction       | Arm          | Correct | Prompt chars |   Input | Cached input | Output | Non-cached input + output | Tool calls | Receiver time (ms) |
| --------------- | ------------ | ------: | -----------: | ------: | -----------: | -----: | ------------------------: | ---------: | -----------------: |
| claude-to-codex | full-history |     2/2 |       24,699 | 201,911 |      143,104 |  6,273 |                    65,080 |          8 |             71,622 |
| claude-to-codex | rirei        |     2/2 |        9,909 | 145,378 |      121,472 |  6,003 |                    29,909 |          6 |             74,995 |
| codex-to-claude | full-history |     2/2 |       21,508 | 287,279 |      264,374 |  6,914 |                    29,819 |         18 |            122,022 |
| codex-to-claude | rirei        |     0/2 |       10,356 | 325,775 |      304,800 |  9,012 |                    29,987 |         25 |            117,290 |

## Paired task outcomes

- claude-to-codex / tenant-ledger: full history pass, Rirei pass. Rirei versus full history: {"promptCharacters":-50.29,"inputTokens":-22.7,"nonCachedTokens":-4.51,"wallTimeMs":13.99,"toolCalls":-25}.
- codex-to-claude / cursor-feed: full history pass, Rirei fail. Rirei versus full history: {"promptCharacters":-51.23,"inputTokens":-25.29,"nonCachedTokens":-12.18,"wallTimeMs":-40.75,"toolCalls":27.27}.
- claude-to-codex / cursor-feed: full history pass, Rirei pass. Rirei versus full history: {"promptCharacters":-65.41,"inputTokens":-33.6,"nonCachedTokens":-77.02,"wallTimeMs":-3.79,"toolCalls":-25}.
- codex-to-claude / tenant-ledger: full history pass, Rirei fail. Rirei versus full history: {"promptCharacters":-52.41,"inputTokens":122.49,"nonCachedTokens":22.64,"wallTimeMs":138.29,"toolCalls":57.14}.

## Limitations

- Two authored tasks per direction, one receiver per arm/checkpoint; no statistical superiority claim.
- Controlled first-stage-only predecessors, not naturalistic interruptions or a full application switch-UI trial.
- Full history means all retained visible evidence, with the same capture bounds/redactions as Rirei.
- Predecessor usage counters are missing after interruption; total lifecycle cost and human effort are unknown.
- Token totals are compared within a receiver provider, not pooled into cross-provider bills or quota estimates.
- Cache reuse, tool-call counts, and path confusion vary; shorter prompts do not imply better continuation.
- Exact requirement-string presence is a lexical diagnostic, not a semantic compliance score.
- Lookup counts are command attempts; literal path-reference audits do not establish filesystem read isolation.
- No Orca runtime, agent-written handoff, reverse interactive capture integration, or Windows acceptance was compared.
