import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const output = execFileSync(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['pack', '--dry-run', '--json', '--ignore-scripts'],
  { encoding: 'utf8' },
);
const reports = JSON.parse(output);
const files = reports[0]?.files?.map((file) => file.path).sort();
const expected = [
  'LICENSE',
  'README.md',
  'THIRD_PARTY_NOTICES.md',
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
