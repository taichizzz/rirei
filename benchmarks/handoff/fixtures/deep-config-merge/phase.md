Implement only the first phase: recursive own-key merging for ordinary plain objects, array replacement, undefined retention, and non-mutation sufficient for public tests. Run the public tests. Investigate, but deliberately do not implement, recursive prototype-key blocking, null-prototype handling, class-instance boundaries, or deep alias isolation. Confirm why Object.assign is not an adequate security-conscious deep merge.

Before stopping, record notes in the CURRENT repository with the Relay CLI in ONE batch command exactly as written (this shell form is required):

relay note import --stdin --source agent --agent antigravity <<'JSON'
{
"schemaVersion": 1,
"notes": [
{ "type": "done", "text": "Foundation implemented: recursive own-key plain-object merging, array replacement, undefined retention, and strict input non-mutation, passing public tests." },
{ "type": "rejected", "text": "Object.assign for security-conscious deep merge", "reason": "Object.assign is shallow, skips inherited safety issues, and leaves nested aliases, so it cannot guarantee deep independent copies." },
{ "type": "decision", "text": "Recurse only into objects whose prototype is Object.prototype or null; treat null and arrays as replacing primitives." },
{ "type": "next", "text": "Block **proto**, prototype, and constructor keys at every depth and return a deep independent copy with isolated aliases, then make npm test pass." }
]
}
JSON

Run exactly that command and nothing else for notes; never run relay handoff, relay switch, or any other relay note command. Do not implement the remaining work.
