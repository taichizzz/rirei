# Handoff efficiency: M4 milestone

Status: **M4 complete and offline-qualified; M5 next.**\
Date: 2026-11-10\
Plan: [handoff-efficiency-plan.md](handoff-efficiency-plan.md).

Subsequent progress: [M5 output/layout preparation](handoff-efficiency-m5.md). The M5-next
decision below records this earlier implementation milestone's completion state; live gates remain separate.

## Delivery and usage

M4 adds exact retained-text windows, current-file windows, deterministic historical lookup,
and bounded multi-query retrieval to the unreleased working-copy CLI.

```sh
relay context evidence <event-id> --start 0 --length 2000
relay context evidence <event-id> --full
relay context find --file src/feed.mjs --kind tool_result --limit 5
relay context find --command-id <derived-command-id> --format json
relay context read --file src/feed.mjs --start-line 20 --line-count 60 --snapshot <id>
relay context read --file src/feed.mjs --content-hash <sha256>
relay context batch --request-file queries.json --snapshot <id>
```

Bounded evidence defaults to JSON; `find`/`read` default to text, and `batch` defaults to JSON.
All support `--format text|json`, `--max-characters`, and `--cursor`. Handoff citations now point
to bounded evidence windows. Submitted requirements retain their existing selection priority.

Calling `evidence <id>` without options retains the existing full-record JSON response;
`--full` makes that choice explicit and cannot be mixed with window options. The legacy `task`
and `history` response shapes remain supported. The new limits apply to bounded retrieval,
not to these legacy full-record interfaces.

| Limit                         | Default / maximum                                  |
| ----------------------------- | -------------------------------------------------- |
| Single complete response      | 2,000 / 8,000 characters; minimum 1,200            |
| Evidence text per page        | 2,000 / 8,000 UTF-16 units before envelope fitting |
| Find matches per page         | 5 / 20, reduced further when the envelope is full  |
| File lines per page           | 60 / 1,000, reduced further by the response budget |
| Batch queries                 | At most 8                                          |
| Complete batch response       | 12,000 characters; configurable down to 2,400      |
| Request-file transport        | 32 KiB UTF-8 JSON; 3-second read deadline          |
| Explicit current-file capture | At most 8 regular files, each at most 1 MiB        |

The response ceiling includes metadata, labels, escaping, cursors, budget fields, and the final
newline. Character counts use UTF-16 string units; `characters / 4` remains a token estimate.
If metadata and a progressing window cannot fit, retrieval reports a budget error instead of
returning an empty page that looks complete.

## Exact ranges and provenance

`evidence-window` returns an event ID, retained-text digest, original record digest, provider/kind
provenance, reported outcome/exit when present, original capture flags, requested range, and
actual returned range. These outcomes are provider reports, separate from M2 host-command
verification. `start` is zero-based; `end` is exclusive. Offsets refer to the exact retained
sanitized text used by full-record lookup.

A start inside a surrogate pair moves to the pair's start; a one-unit request can expand to
two units to return that pair. Actual coordinates make the adjustment explicit. Successive
unmodified cursors join without skipped or duplicated text. Original capture truncation and
redaction remain separate from page truncation; reaching the end of retained text does not
recover uncaptured content or establish complete conversation coverage.

`file-window` returns exact UTF-8 source text, including a BOM and CRLF where present. It
includes a source path/ID, raw content SHA-256, anchor scope, and requested/returned line and
character coordinates. Lines are one-based, columns are zero-based UTF-16 units, and returned
end coordinates are exclusive. A long line can span pages; the cursor preserves its exact
column/character offset.

Files require a matching complete `--snapshot` or a matching `--content-hash`. The latter
explicitly qualifies only that file's contents, even if other snapshot coverage is partial.
Both use bytes retained from consistent M2 scans; M2's identity algorithm is unchanged.
Ignored, missing, nonregular, sensitive-path, binary, invalid-UTF-8, oversized, or unstable files
fail clearly. A source containing a recognized secret is withheld so an exact-file response
does not silently replace source text. No test-reuse qualification is inferred from a file read.

`--length` and `--line-count` are per-page source limits. `nextCursor` continues the remaining
source; callers can stop once their requested inspection is satisfied. A null cursor means
the retained/observed source is exhausted. It does not mean unrelated requirements are complete.

## Find and the derived index

`find` intersects exact reported `--file`, `--kind`, `--tool-id`, and `--command-id` filters.
Matches stay in receipt order and carry source IDs/digests, bounded previews, provenance,
reported outcomes, and omission flags. File paths in historical records remain data; lookup
does not infer dependencies from a command string or turn a historical path into read authority.

Derived `c-…` command IDs group a provider/run's reported tool ID when a command was observed;
without a tool ID, grouping uses its exact retained command string. This groups recorded evidence
and does not prove execution. `find --kind prompt_submission` with cursor continuation reaches
all retained submissions, including histories longer than twenty records.

A four-entry in-memory index cache is keyed by version, task, canonical workspace, and journal
digest. Its internal maps and source objects are not exposed for mutation. Every invocation
revalidates the hash-linked journal before lookup. No persistent index or query telemetry is written.

## Continuation contract

Cursors bind semantic task state, canonical workspace, capture policy/epoch, journal version,
query filters/ranges, and the selected source identity. Snapshot-anchored reads also bind the
complete snapshot; hash-only reads bind the selected file. Source, task, consent, history, or
semantic-query changes require a fresh query. Storage-only state revisions are acceptable.

Repeat the **same query arguments** with `--cursor`. Format and response budget can change
because they do not change source selection. Cursors are bounded, validated, checksummed
continuation values, not authentication capabilities; normal source/access checks still run.
Task/history/consent are checked again before a response is returned.

Managed readers use the existing task/capability/worktree/disclosure checks. An operator can
explicitly retrieve retained evidence while capture is disabled, matching legacy full lookup;
disabled capture still excludes that history from automatic handoffs. Cross-task/workspace source
IDs fail lookup, and a cursor from another workspace cannot resume an otherwise identical file.

## Batch requests

Example `queries.json` (replace the event ID with an actual retained source):

```json
{
  "schemaVersion": 1,
  "queries": [
    {
      "id": "failure",
      "type": "evidence",
      "eventId": "e-0123456789abcdef0123456789abcdef",
      "start": 0,
      "length": 1000
    },
    {
      "id": "code",
      "type": "read",
      "file": "src/feed.mjs",
      "startLine": 20,
      "lineCount": 60
    },
    {
      "id": "related",
      "type": "find",
      "file": "src/feed.mjs",
      "kind": "tool_result",
      "limit": 5
    }
  ]
}
```

Create the request file **before obtaining the snapshot**, then pass the ID through the batch
command's `--snapshot` flag. This avoids putting a self-referential snapshot ID inside a covered
request file. Individual read queries can instead supply `contentHash`, or their own `snapshot`
when the request transport is already outside the covered input set. Ignored regular request
files are allowed as transport; recorder paths, sensitive paths, symlinks, and escapes are refused.

Each page includes every query ID with one of these statuses:

- `ok`: this page contains a result, potentially with its own continuation.
- `error`: a source-specific error is explicit; other queries still proceed.
- `deferred`: this query did not fit yet and remains in the aggregate continuation.
- `done`: an earlier page exhausted this query successfully.

The aggregate cursor binds the complete normalized request and all source versions. Scheduling
rotates after progress so deferred queries are reached. Request mutation is checked before return.
An item's cursor can also resume through its equivalent standalone command with the same query
arguments. Batch generation succeeds with explicit per-item errors; callers must inspect statuses
rather than treating a zero process exit as every source succeeding.

## Offline qualification and measurements

The isolated local checkout passed `npm run verify`: TypeScript, ESLint, formatting, build,
**824 passed / 3 skipped**, including 28 new regressions. The six interruption fixtures, both
two-way workflow validators, and the 13-file package allowlist passed. Benchmark modules also
passed explicit Node-global lint. Packed global CLI install, first-task TUI, daemon/PTY,
reinstall, and uninstall smoke passed in temporary installation directories.

Coverage includes exact Unicode/BOM/CRLF reconstruction, partial long lines, 27 submitted
requirements, exact field lookup, legacy/source/compiled CLI compatibility, mutation and corruption
invalidation, task/workspace/consent boundaries, source refusal, and eight-query batch progress.
All four saved control cases still retain **6/6 original requirements** in handoffs and inspection.
The source control archive and historical live results were preserved.

The temporary verification directory was cleared during this milestone. A fresh detached checkout
was rebuilt from the released base; 107 intended prototype files were byte-verified into it and
dependencies restored before the final full suite. Project edits and the persistent control survived.

The [numeric/hash-only report](../benchmarks/continuity/reports/m4-retrieval.json) records an
authored workload with 43 historical records and two 1,200-line files. It requests one 200-character
failure window and two exact two-line file windows through the compiled CLI:

| Retrieval workflow                                | Executed read commands | Returned UTF-8 bytes |
| ------------------------------------------------- | ---------------------: | -------------------: |
| Three full-history pages plus two full-file reads |                      5 |              279,909 |
| Exact-field find plus a three-query batch         |                      2 |                4,764 |

The targeted workflow returned **98.30% fewer bytes** for this declared workload. Source fields
and desired ranges were preselected; this is not a comparison with an optimal shell workflow or
a measurement of model turns, tokenization, subscription cost, or continuation speed. Non-null
cursors explicitly retain access to the rest of each source. M4 used zero live provider sessions.

Reproduce offline:

```sh
npm run build
node --import tsx benchmarks/continuity/retrieve.mjs
node --import tsx benchmarks/continuity/retrieve.mjs --control <private-frozen-control-directory>
```

**Milestone decision:** proceed to M5's output/cache tuning experiments. The M2–M4 candidate is
ready for the plan's separately authorized E1 smoke evaluation; no new live budget has been granted.
Native Windows continuity and general interactive Codex capture remain separately unqualified.
