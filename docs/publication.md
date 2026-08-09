# Publication

Rirei is MIT-licensed source, but publishing safely requires more than adding `LICENSE`.

## Preflight

Run from a clean clone with Node.js 22.12 or newer:

```sh
npm ci
npm run verify
npm run audit:production
npm run package:check
```

Review `git status`, the complete diff, package contents, dependency changes, and every commit
that will become public. Confirm that `AppIcon.icns` matches `ASSET_PROVENANCE.md` and that the
vendored xterm files match `THIRD_PARTY_NOTICES.md`.

## Local state

The entire `.relay/` directory is ignored. It can contain absolute paths, task requests,
provider/run identifiers, local history, checkpoints, patches, and test output. Never publish
it as a fixture or support attachment without deliberate redaction.

`.relay/config.json` and `.relay/state.json` were tracked in the repository's early history.
Removing them from the current tree does not erase old commits. Before announcing the public
repository, choose one of these approaches:

1. Create a reviewed clean public history containing only release-safe source.
2. Rewrite the existing history with a tool such as `git filter-repo`, coordinate with all
   collaborators, and force-push only after explicit approval and a backup.

Do not assume a normal deletion commit removes previously published personal data.

## Release boundaries

- The npm package currently remains `private`; the allowlist is a safety check and preparation,
  not authorization to publish it.
- Source publication does not imply that unsigned desktop binaries are production-ready.
- Developer ID signing, hardened runtime review, notarization, stapling, checksums, and a clean
  macOS installation test remain required for a desktop binary release.
- Provider names are descriptive compatibility references. Rirei is not affiliated with or
  endorsed by those providers.
