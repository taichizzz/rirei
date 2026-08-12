Implement only the first phase required by public tests: validate the array, basic event id/sequence shape, unique ids, and deterministic sequence-then-id ordering for independent events. Run public tests. Investigate, but deliberately do not implement, dependency validation, topological ordering, or cycle detection. Confirm why one global comparator sort cannot enforce transitive dependency readiness.

Before stopping, record notes in the CURRENT repository with the Relay CLI in ONE batch command exactly as written (this shell form is required):

relay note import --stdin --source agent --agent antigravity <<'JSON'
{
"schemaVersion": 1,
"notes": [
{ "type": "done", "text": "Shape foundation implemented: array validation, event id/sequence shape checks, unique ids, and deterministic sequence-then-id ordering for independent events, passing public tests." },
{ "type": "rejected", "text": "One global comparator sort for ordering", "reason": "A single comparator sort cannot enforce transitive dependency readiness, so it cannot produce a valid topological order." },
{ "type": "decision", "text": "Use Kahn topological ordering with a ready queue keyed by sequence then lexicographic id." },
{ "type": "next", "text": "Validate after dependencies, reject self-dependencies, unknown dependencies, duplicates, and cycles with descriptive errors, then make npm test pass." }
]
}
JSON

Run exactly that command and nothing else for notes; never run relay handoff, relay switch, or any other relay note command. Do not implement the remaining work.
