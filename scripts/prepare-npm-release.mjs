import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const tag = process.argv[2];
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const desktop = JSON.parse(readFileSync('desktop/package.json', 'utf8'));
assert.equal(manifest.name, '@taichizzz/rirei');
assert.match(tag ?? '', /^v\d+\.\d+\.\d+-alpha\.\d+(?:\.\d+)?$/);
assert.equal(
  tag,
  `v${manifest.version}`,
  'Release tag must match the package version',
);
assert.equal(lock.version, manifest.version);
assert.equal(lock.packages[''].version, manifest.version);
assert.equal(desktop.version, manifest.version);
const sourceVersion = readFileSync('src/version.ts', 'utf8').match(
  /RIREI_VERSION = '([^']+)'/,
);
assert.equal(sourceVersion?.[1], manifest.version);
const installerVersions = [
  ...readFileSync('scripts/install-windows.ps1', 'utf8').matchAll(
    /\[string\]\$Version = '([^']+)'/g,
  ),
];
assert.ok(
  installerVersions.length > 0,
  'Installer must pin its default alpha version',
);
assert.ok(
  installerVersions.every((match) => match[1] === manifest.version),
  'Installer defaults must match the package version',
);
assert.notEqual(
  manifest.private,
  true,
  'The alpha CLI package must be publishable',
);
assert.deepEqual(manifest.publishConfig, { access: 'public', tag: 'alpha' });
assert.equal(
  execFileSync(process.execPath, ['dist/index.cjs', '--version'], {
    encoding: 'utf8',
  }).trim(),
  manifest.version,
);
assert.equal(
  execFileSync('git', ['rev-parse', `${tag}^{commit}`], {
    encoding: 'utf8',
  }).trim(),
  execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
);
execFileSync('git', ['merge-base', '--is-ancestor', 'HEAD', 'origin/main']);
execFileSync('git', ['diff', '--exit-code']);
execFileSync('git', ['diff', '--cached', '--exit-code']);
process.stdout.write(
  `Validated ${manifest.name}@${manifest.version} for the alpha dist-tag.\n`,
);
