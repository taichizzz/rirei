Implement only the lexical first phase required by public tests: canonicalize and validate the root, reject empty/NUL/absolute/`..` candidates, and resolve ordinary existing or missing paths. Run public tests. Investigate, but deliberately do not implement, component-by-component symlink handling, broken links, loops, or non-directory intermediates. Demonstrate why `target.startsWith(root)` accepts a sibling such as `work-evil`.

Before stopping, record notes in the CURRENT repository with the Relay CLI in ONE batch command exactly as written (this shell form is required):

relay note import --stdin --source agent --agent antigravity <<'JSON'
{
"schemaVersion": 1,
"notes": [
{ "type": "done", "text": "Lexical foundation implemented: root canonicalization and validation, rejection of empty/NUL/absolute/.. candidates, and ordinary existing or missing path resolution, passing public tests." },
{ "type": "rejected", "text": "target.startsWith(root) boundary check", "reason": "String-prefix containment accepts sibling paths such as work-evil, so path.relative boundary checks are required." },
{ "type": "decision", "text": "Use path.relative boundary checks, never string-prefix containment, for escape detection." },
{ "type": "next", "text": "Realpath each existing component, reject broken links, loops, and non-directory intermediates, and safely resolve missing tails, then make npm test pass." }
]
}
JSON

Run exactly that command and nothing else for notes; never run relay handoff, relay switch, or any other relay note command. Do not implement the remaining work.
