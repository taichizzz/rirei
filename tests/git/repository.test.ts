import { execFile } from 'node:child_process';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  discoverRepository,
  ensureRelayLocalExclusion,
  GIT_EXCLUDE_ABSOLUTE_ARGS,
  gitExcludePath,
  inspectGitBaseline,
  inspectGitSnapshot,
  installRelayLocalExclusion,
} from '../../src/git/repository.js';
import { createRepository, removeRepository } from '../helpers.js';

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeRepository));
});

describe('repository discovery', () => {
  it('discovers the repository and a clean baseline', async () => {
    const root = await createRepository();
    directories.push(root);
    const discovered = await discoverRepository(root);
    expect(discovered).not.toBeNull();
    await expect(inspectGitBaseline(root)).resolves.toMatchObject({
      root: discovered,
      branch: 'main',
      dirty: false,
    });
  });

  it('reports a dirty baseline', async () => {
    const root = await createRepository();
    directories.push(root);
    await writeFile(path.join(root, 'README.md'), '# Changed\n');
    await expect(inspectGitBaseline(root)).resolves.toMatchObject({
      dirty: true,
    });
  });

  it('fingerprints the bounded Git snapshot before patch truncation', async () => {
    const root = await createRepository();
    directories.push(root);
    const clean = await inspectGitSnapshot(root, 1);
    await writeFile(path.join(root, 'README.md'), '# Changed\n');
    const changed = await inspectGitSnapshot(root, 1);
    expect(clean.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(changed.fingerprint).not.toBe(clean.fingerprint);
    expect(changed.patchTruncated).toBe(true);
  });
});

describe('local Relay exclusion', () => {
  it('uses the required absolute Git path command', () => {
    expect(GIT_EXCLUDE_ABSOLUTE_ARGS).toEqual([
      'rev-parse',
      '--path-format=absolute',
      '--git-path',
      'info/exclude',
    ]);
  });

  it('resolves the exclude path through Git', async () => {
    const root = await createRepository();
    directories.push(root);
    const exclude = await gitExcludePath(root);
    expect(exclude.endsWith(path.join('.git', 'info', 'exclude'))).toBe(true);
  });

  it('installs one root-anchored exclude line and hides .relay from git status', async () => {
    const root = await createRepository();
    directories.push(root);
    await installRelayLocalExclusion(root);
    await mkdir(path.join(root, '.relay'), { recursive: true });
    await writeFile(path.join(root, '.relay', 'state.json'), '{}');
    await writeFile(path.join(root, 'visible-source.js'), 'export {};\n');
    const status = await execFileAsync(
      'git',
      ['status', '--porcelain=v1', '--untracked-files=all'],
      { cwd: root },
    );
    expect(status.stdout).not.toMatch(/\.relay/);
    expect(status.stdout).toContain('visible-source.js');
    await expect(access(path.join(root, '.gitignore'))).rejects.toThrow();
    await execFileAsync(
      'git',
      ['check-ignore', '-q', '--', '.relay/state.json'],
      { cwd: root },
    );
  });

  it('is idempotent and preserves existing exclude content', async () => {
    const root = await createRepository();
    directories.push(root);
    const exclude = await gitExcludePath(root);
    await writeFile(exclude, '# user line\nuser-path/\n');
    await installRelayLocalExclusion(root);
    await installRelayLocalExclusion(root);
    const contents = await readFile(exclude, 'utf8');
    expect(contents).toContain('# user line\n');
    expect(contents).toContain('user-path/\n');
    expect(contents.match(/^\/\.relay\/$/gm)).toHaveLength(1);
  });

  it('preserves the existing exclude file mode', async () => {
    const root = await createRepository();
    directories.push(root);
    const exclude = await gitExcludePath(root);
    await chmod(exclude, 0o600);
    await installRelayLocalExclusion(root);
    if (process.platform !== 'win32')
      expect((await stat(exclude)).mode & 0o777).toBe(0o600);
  });

  it('handles a missing final newline', async () => {
    const root = await createRepository();
    directories.push(root);
    const exclude = await gitExcludePath(root);
    await writeFile(exclude, '# no newline');
    await installRelayLocalExclusion(root);
    const contents = await readFile(exclude, 'utf8');
    expect(contents).toBe('# no newline\n/.relay/\n');
  });

  it('rejects a symlinked exclude file', async () => {
    const root = await createRepository();
    directories.push(root);
    const exclude = await gitExcludePath(root);
    await rm(exclude, { force: true });
    const target = path.join(tmpdir(), `relay-exclude-target-${Date.now()}`);
    await symlink(target, exclude);
    directories.push(target);
    await expect(installRelayLocalExclusion(root)).rejects.toThrow(
      /symlink|regular/i,
    );
  });

  it('repairs an older initialized repository', async () => {
    const root = await createRepository();
    directories.push(root);
    await mkdir(path.join(root, '.relay'), { recursive: true });
    await writeFile(path.join(root, '.relay', 'state.json'), '{}');
    await ensureRelayLocalExclusion(root);
    const exclude = await gitExcludePath(root);
    const contents = await readFile(exclude, 'utf8');
    expect(contents).toContain('/.relay/');
    const status = await execFileAsync(
      'git',
      ['status', '--porcelain=v1', '--untracked-files=all'],
      { cwd: root },
    );
    expect(status.stdout).not.toMatch(/\.relay/);
  });

  it('supports linked worktrees', async () => {
    const root = await createRepository();
    directories.push(root);
    const wt = await mkdtemp(path.join(tmpdir(), 'relay-wt-'));
    directories.push(wt);
    await execFileAsync('git', ['worktree', 'add', wt, '-b', 'wt-branch'], {
      cwd: root,
    });
    await installRelayLocalExclusion(wt);
    await mkdir(path.join(wt, '.relay'), { recursive: true });
    await writeFile(path.join(wt, '.relay', 'state.json'), '{}');
    const status = await execFileAsync(
      'git',
      ['status', '--porcelain=v1', '--untracked-files=all'],
      { cwd: wt },
    );
    expect(status.stdout).not.toMatch(/\.relay/);
  });
});
