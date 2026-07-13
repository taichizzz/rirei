import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function createRepository(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-test-'));
  await execFileAsync('git', ['init', '--initial-branch=main'], {
    cwd: directory,
  });
  await execFileAsync('git', ['config', 'user.email', 'relay@example.test'], {
    cwd: directory,
  });
  await execFileAsync('git', ['config', 'user.name', 'Relay Test'], {
    cwd: directory,
  });
  await writeFile(path.join(directory, 'README.md'), '# Test\n');
  await execFileAsync('git', ['add', 'README.md'], { cwd: directory });
  await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: directory });
  return directory;
}

export async function removeRepository(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}
