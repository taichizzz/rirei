Implement only the flat operations (add, replace, remove, test) sufficient for public tests. Run public tests. Investigate, but deliberately do not implement, RFC 6901 pointer unescaping (~0, ~1), array append '-' or index insertion, move, copy, or non-serializable value preservation. Confirm why JSON.parse is unsafe for transactional document rollback.

Before stopping, record notes in the CURRENT repository with the Relay CLI in ONE batch command exactly as written (this shell form is required):

relay note import --stdin --source agent --agent antigravity <<'JSON'
{
"schemaVersion": 1,
"notes": [
{ "type": "done", "text": "Foundation implemented: flat operations for add, replace, remove, and test with rollback, passing public tests." },
{ "type": "rejected", "text": "JSON.parse and JSON.stringify cloning for rollback", "reason": "JSON.parse(JSON.stringify(doc)) corrupts non-JSON types like Date and BigInt, drops undefined, and is inefficient." },
{ "type": "decision", "text": "Track atomic inverse operations in reverse order for in-place rollback upon failure." },
{ "type": "next", "text": "Implement RFC 6901 pointer unescaping (~0, ~1), array append '-', move, copy, and non-serializable value preservation, then make npm test pass." }
]
}
JSON

Run exactly that command and nothing else for notes; never run relay handoff, relay switch, or any other relay note command. Do not implement the remaining work.
