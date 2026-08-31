import { readFile } from 'node:fs/promises';
import spawn from 'cross-spawn';

const packed = spawn.sync(
  'npm',
  ['pack', '--dry-run', '--json', '--ignore-scripts'],
  { encoding: 'utf8' },
);
if (packed.error) throw packed.error;
if (packed.status !== 0) {
  throw new Error(
    `npm pack exited ${packed.status}: ${packed.stderr || packed.stdout}`,
  );
}
const reports = JSON.parse(packed.stdout);
const files = reports[0]?.files?.map((file) => file.path).sort();
const expected = [
  'LICENSE',
  'README.md',
  'THIRD_PARTY_NOTICES.md',
  'desktop/codex-lifecycle-wrapper.mjs',
  'desktop/opencode-lifecycle-wrapper.mjs',
  'desktop/provider-lifecycle-hook.cjs',
  'dist/index.cjs',
  'package.json',
].sort();

if (JSON.stringify(files) !== JSON.stringify(expected)) {
  throw new Error(
    `Unexpected npm package contents:\n${JSON.stringify(files, null, 2)}`,
  );
}

for (const file of files) {
  const content = await readFile(file, 'utf8');
  if (/\/Users\/[^/\s]+|[A-Za-z]:\\Users\\[^\\\s]+/.test(content)) {
    throw new Error(`Local user path found in package file: ${file}`);
  }
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content)) {
    throw new Error(`Private key material found in package file: ${file}`);
  }
}

process.stdout.write(`Package contents verified (${files.length} files).\n`);
