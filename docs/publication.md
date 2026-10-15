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

- Alpha.5.1 prepares a public CLI package with `publishConfig.access=public` and the `alpha`
  dist-tag. Package metadata is ready for publication; it does not mean npm publication has
  already happened. The existing alpha.5.0 GitHub release remains source-only.
- Source publication does not imply that unsigned desktop binaries are production-ready.
- Developer ID signing, hardened runtime review, notarization, stapling, checksums, and a clean
  macOS installation test remain required for a desktop binary release.
- Provider names are descriptive compatibility references. Rirei is not affiliated with or
  endorsed by those providers.

## Publishing the CLI alpha

The `Publish CLI alpha` workflow in `.github/workflows/release.yml` is manually dispatched.
Its default is validation only. Supply an existing alpha tag such as `v0.1.0-alpha.5.1`.
The workflow verifies that the tag matches all package/version metadata and belongs to
`main`, runs local checks, and packs the compiled CLI once. Windows/macOS/Linux jobs on
Node.js 22 and 24 install that exact uploaded tarball into an isolated global prefix and
exercise first-task TUI setup through a real PTY, the daemon, terminal, reinstall, diagnostics,
data preservation, and uninstall.
The Windows jobs also test the setup script with mocked commands.

Enable npm publication only after these steps:

1. Merge the reviewed changes into `main`, pass the required checks, and create the matching tag.
2. Create/configure the public `@taichizzz/rirei` package under the npm account that owns the scope.
3. Configure an npm trusted publisher for GitHub repository `taichizzz/rirei` and workflow
   filename `release.yml`. This uses GitHub OIDC and does not store a long-lived npm token.
   If npm requires an initial manual publication before trusted-publisher configuration,
   the scope owner must do that first using their own authenticated npm account and the
   verified tarball: `npm publish <tarball> --access public --tag alpha`.
4. Dispatch the workflow on the matching **tag ref** with `publish=true`, for example
   `gh workflow run release.yml --ref v0.1.0-alpha.5.1 -f tag=v0.1.0-alpha.5.1 -F publish=true`.
   Publishing from a different workflow ref is rejected so provenance identifies the source tag.
   It publishes the already-tested tarball with
   provenance under `alpha`, never `latest`. Published versions are immutable; use a new
   alpha version for corrections.

`scripts/install-windows.ps1` embeds an exact default version. Update it with package,
lockfile, desktop, and `src/version.ts` metadata for each installable alpha.

`npm run smoke:packed` tests a reinstall for the first publication. For a real upgrade from
a previous published artifact, run `node scripts/smoke-packed-install.mjs --tarball <new.tgz>
--upgrade-from <old.tgz>`. Project state, config, usage preferences, and cache must survive.
Native Windows Terminal acceptance (input, paste, resize, permission prompts, attach/detach,
and provider handoff) still needs a hands-on test before advertising broader Windows support.
