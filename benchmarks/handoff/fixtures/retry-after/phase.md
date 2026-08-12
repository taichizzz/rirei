Implement only the first phase of the task in this repository: strict nonnegative integer delay-seconds and response header lookup sufficient for the public tests. Run the public tests. Investigate, but deliberately do not implement, IMF-fixdate parsing, date clamping, and overflow handling. Verify why parseInt is unsafe for protocol input such as `12junk`.

Before stopping, record notes in the CURRENT repository with the Relay CLI in ONE batch command exactly as written (this shell form is required):

relay note import --stdin --source agent --agent antigravity <<'JSON'
{
"schemaVersion": 1,
"notes": [
{ "type": "done", "text": "Foundation implemented: nonnegative integer delay-seconds with header lookup via response.headers.get('retry-after'), passing public tests." },
{ "type": "rejected", "text": "parseInt for Retry-After parsing", "reason": "parseInt silently accepts malformed prefixes such as 12junk, which is unsafe for protocol input." },
{ "type": "next", "text": "Implement IMF-fixdate validation, past-date clamping, and MAX_TIMEOUT_MS overflow capping, then make npm test pass." }
]
}
JSON

Run exactly that command and nothing else for notes; never run relay handoff, relay switch, or any other relay note command. Do not implement the remaining work.
