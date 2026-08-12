Implement only the basic Map-like first phase required by public tests: constructor validation, set/get/has/delete/clear/size, replacement, and stored expiry metadata. Run public tests. Investigate, but deliberately do not implement, lazy expiry, capacity eviction, LRU refresh rules, ttl zero, or purge-before-eviction behavior. Confirm why setTimeout is nondeterministic and creates avoidable timer/resource behavior here.

Before stopping, record notes in the CURRENT repository with the Relay CLI in ONE batch command exactly as written (this shell form is required):

relay note import --stdin --source agent --agent antigravity <<'JSON'
{
"schemaVersion": 1,
"notes": [
{ "type": "done", "text": "Map-like foundation implemented: constructor validation, set/get/has/delete/clear/size, key replacement, and stored expiry metadata, passing public tests." },
{ "type": "rejected", "text": "setTimeout for TTL expiry", "reason": "setTimeout is nondeterministic and creates avoidable timer and resource behavior; expiry must be lazy and monotonic." },
{ "type": "decision", "text": "Use the injected monotonic now() clock with lazy expiry on access instead of timers." },
{ "type": "next", "text": "Implement lazy expiry, LRU capacity eviction, get-refreshes-recentness with has-without-refresh semantics, and ttlMs 0 immediate expiry, then make npm test pass." }
]
}
JSON

Run exactly that command and nothing else for notes; never run relay handoff, relay switch, or any other relay note command. Do not implement the remaining work.
