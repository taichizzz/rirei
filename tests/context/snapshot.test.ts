import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectCoveredSnapshot } from '../../src/context/snapshot.js';
import { inspectGitSnapshot } from '../../src/git/repository.js';
import { createRepository, removeRepository } from '../helpers.js';

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(removeRepository));
});
async function repo() {
  const root = await createRepository();
  roots.push(root);
  return root;
}
async function git(root: string, ...args: string[]) {
  return execute('git', args, { cwd: root });
}
const snapshot = (root: string) =>
  inspectCoveredSnapshot(root, { timeoutMs: 10000 });

describe('covered-input snapshot v1', () => {
  it('is stable across independent scans and hashes same-name untracked edits', async () => {
    const root = await repo();
    await writeFile(path.join(root, 'new.mjs'), 'one');
    const before = await snapshot(root);
    const same = await snapshot(root);
    expect(before.identity.coverage.status).toBe('complete');
    expect(before.identity.id).toBe(same.identity.id);
    expect(before.attempts).toBe(2);
    await writeFile(path.join(root, 'new.mjs'), 'two');
    const after = await snapshot(root);
    expect(after.identity.id).not.toBe(before.identity.id);
    expect(after.identity.worktreeDigest).not.toBe(
      before.identity.worktreeDigest,
    );
    expect(after.files.find((file) => file.path === 'new.mjs')).toMatchObject({
      source: 'untracked',
      kind: 'file',
      bytes: 3,
    });
  });
  it('distinguishes different staged states hidden by the same HEAD-to-worktree diff', async () => {
    const root = await repo();
    const file = path.join(root, 'README.md');
    const original = await readFile(file);
    await writeFile(file, 'staged version B');
    await git(root, 'add', 'README.md');
    await writeFile(file, original);
    const legacy = await inspectGitSnapshot(root, 1000);
    const before = await snapshot(root);
    await writeFile(file, 'staged version C');
    await git(root, 'add', 'README.md');
    await writeFile(file, original);
    const after = await snapshot(root);
    expect((await inspectGitSnapshot(root, 1000)).fingerprint).toBe(
      legacy.fingerprint,
    );
    expect(after.identity.worktreeDigest).toBe(before.identity.worktreeDigest);
    expect(after.identity.indexDigest).not.toBe(before.identity.indexDigest);
    expect(after.identity.id).not.toBe(before.identity.id);
  });
  it('handles spaces, Unicode, and platform-supported separators in NUL-safe Git paths', async () => {
    const root = await repo();
    const names = [
      'space name.mjs',
      '日本語.mjs',
      ...(process.platform === 'win32'
        ? []
        : ['tab\tname.mjs', 'line\nbreak.mjs']),
    ];
    for (const name of names) await writeFile(path.join(root, name), name);
    await git(root, 'add', '--', ...names);
    const result = await snapshot(root);
    expect(result.identity.coverage.status).toBe('complete');
    for (const name of names)
      expect(result.files.find((file) => file.path === name)?.contentHash).toBe(
        createHash('sha256').update(name).digest('hex'),
      );
  });
  it('captures rename, deletion, and executable-mode changes', async () => {
    const root = await repo();
    const before = await snapshot(root);
    await git(root, 'mv', 'README.md', 'renamed.md');
    const renamed = await snapshot(root);
    expect(renamed.identity.id).not.toBe(before.identity.id);
    expect(renamed.files.find((file) => file.path === 'README.md')?.kind).toBe(
      'deleted',
    );
    if (process.platform !== 'win32') {
      await chmod(path.join(root, 'renamed.md'), 0o755);
      expect((await snapshot(root)).identity.id).not.toBe(renamed.identity.id);
    }
    await unlink(path.join(root, 'renamed.md'));
    expect(
      (await snapshot(root)).files.find((file) => file.path === 'renamed.md')
        ?.kind,
    ).toBe('deleted');
  });
  it('includes HEAD-tracked paths removed from the index even when newly ignored', async () => {
    const root = await repo();
    await git(root, 'rm', '--cached', 'README.md');
    await writeFile(path.join(root, '.gitignore'), 'README.md\n');
    const before = await snapshot(root);
    await writeFile(
      path.join(root, 'README.md'),
      'changed ignored former tracked input',
    );
    expect((await snapshot(root)).identity.id).not.toBe(before.identity.id);
  });
  it('hashes content independently of unchanged size and restored modification time', async () => {
    const root = await repo();
    const file = path.join(root, 'fixed');
    await writeFile(file, 'aaa');
    const time = new Date('2020-01-01T00:00:00Z');
    await utimes(file, time, time);
    const before = await snapshot(root);
    await writeFile(file, 'bbb');
    await utimes(file, time, time);
    expect((await snapshot(root)).identity.id).not.toBe(before.identity.id);
  });
  it('excludes recorder state even when it was accidentally tracked', async () => {
    const root = await repo();
    await mkdir(path.join(root, '.relay'));
    const file = path.join(root, '.relay/state.json');
    await writeFile(file, '{}');
    await git(root, 'add', '-f', '.relay/state.json');
    await git(root, 'commit', '-m', 'Fixture recorder state');
    const before = await snapshot(root);
    await writeFile(file, '{"changed":true}');
    const after = await snapshot(root);
    expect(after.identity.id).toBe(before.identity.id);
    expect(after.files.some((file) => file.path.startsWith('.relay'))).toBe(
      false,
    );
  });
  it('covers lockfiles/configuration and keeps ignored or sensitive inputs explicit', async () => {
    const root = await repo();
    await writeFile(path.join(root, 'package-lock.json'), '{"version":1}');
    await writeFile(path.join(root, '.gitignore'), '*.generated\n.env\n');
    await writeFile(path.join(root, 'cache.generated'), 'one');
    const before = await snapshot(root);
    await writeFile(path.join(root, 'cache.generated'), 'two');
    expect((await snapshot(root)).identity.id).toBe(before.identity.id);
    await writeFile(path.join(root, 'package-lock.json'), '{"version":2}');
    expect((await snapshot(root)).identity.dependencyDigest).not.toBe(
      before.identity.dependencyDigest,
    );
    const secret = `sk-ant-${'x'.repeat(40)}`;
    await writeFile(path.join(root, '.env'), secret);
    await git(root, 'add', '-f', '.env');
    const sensitive = await snapshot(root);
    expect(sensitive.identity.coverage.status).toBe('partial');
    expect(sensitive.identity.coverage.reasons).toContain(
      'sensitive-input-excluded',
    );
    expect(JSON.stringify(sensitive)).not.toContain(secret);
    expect(JSON.stringify(sensitive)).not.toContain(
      createHash('sha256').update(secret).digest('hex'),
    );
  });
  it.skipIf(process.platform === 'win32')(
    'does not follow leaf or ancestor symlinks into another tree',
    async () => {
      const root = await repo();
      const outside = await repo();
      await writeFile(path.join(outside, 'secret'), 'outside-value');
      await symlink(path.join(outside, 'secret'), path.join(root, 'link'));
      const leaf = await snapshot(root);
      expect(leaf.files.find((file) => file.path === 'link')?.kind).toBe(
        'symlink',
      );
      expect(leaf.identity.coverage.status).toBe('partial');
      expect(JSON.stringify(leaf)).not.toContain('outside-value');
      await mkdir(path.join(root, 'folder'));
      await writeFile(path.join(root, 'folder/secret'), 'inside');
      await git(root, 'add', 'folder/secret');
      await rm(path.join(root, 'folder'), { recursive: true });
      await symlink(outside, path.join(root, 'folder'));
      const parent = await snapshot(root);
      expect(parent.identity.coverage.status).toBe('partial');
      expect(
        parent.files.find((file) => file.path === 'folder/secret')?.contentHash,
      ).toBeNull();
    },
  );
  it('reports submodule input coverage as partial instead of treating a gitlink as a full tree', async () => {
    const root = await repo();
    const child = path.join(root, 'vendor');
    await mkdir(child);
    const head = (await git(root, 'rev-parse', 'HEAD')).stdout.trim();
    await git(
      root,
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${head},vendor`,
    );
    const result = await snapshot(root);
    expect(result.files.find((file) => file.path === 'vendor')?.kind).toBe(
      'gitlink',
    );
    expect(
      result.files.find((file) => file.path === 'vendor')?.contentHash,
    ).toBeNull();
    expect(result.identity.coverage.reasons).toContain(
      'submodule-checkout-not-covered',
    );
    expect(result.identity.coverage.reasons).toContain(
      'submodule-content-not-covered',
    );
    expect(result.identity.coverage.status).toBe('partial');
  });
  it('discloses file, byte, output, and deadline limits instead of minting a complete identity', async () => {
    const root = await repo();
    await writeFile(path.join(root, 'more'), 'larger than two bytes');
    expect(
      (await inspectCoveredSnapshot(root, { maxFiles: 1, timeoutMs: 10000 }))
        .identity.coverage.status,
    ).toBe('partial');
    expect(
      (
        await inspectCoveredSnapshot(root, {
          maxFileBytes: 2,
          timeoutMs: 10000,
        })
      ).identity.coverage.status,
    ).toBe('partial');
    const limited = await inspectCoveredSnapshot(root, {
      maxGitBytes: 16,
      timeoutMs: 10000,
    });
    expect(limited.identity.coverage.status).not.toBe('complete');
    expect(limited.identity.coverage.reasons).toContain('git-output-limit');
    expect(
      (await inspectCoveredSnapshot(root, { timeoutMs: 1 })).identity.coverage
        .status,
    ).not.toBe('complete');
  });
  it('binds inspection to the requested repository instead of inherited Git routing', async () => {
    const root = await repo();
    const outside = await repo();
    const before = await snapshot(root);
    vi.stubEnv('GIT_DIR', path.join(outside, '.git'));
    vi.stubEnv('GIT_WORK_TREE', outside);
    vi.stubEnv('GIT_INDEX_FILE', path.join(outside, '.git/index'));
    vi.stubEnv('GIT_LITERAL_PATHSPECS', '1');
    expect((await snapshot(root)).identity.id).toBe(before.identity.id);
    await mkdir(path.join(root, 'subdirectory'));
    const nested = await snapshot(path.join(root, 'subdirectory'));
    expect(nested.identity.coverage.status).toBe('unavailable');
    expect(nested.identity.coverage.reasons).toContain(
      'repository-root-mismatch',
    );
  });
  it('retries one changed boundary and refuses a continuously changing input', async () => {
    const root = await repo();
    const file = path.join(root, 'changing');
    await writeFile(file, 'a');
    const recovered = await inspectCoveredSnapshot(
      root,
      { timeoutMs: 10000 },
      {
        afterScan: async (attempt) => {
          if (attempt === 1) await writeFile(file, 'b');
        },
      },
    );
    expect(recovered.attempts).toBe(3);
    expect(recovered.identity.coverage.status).toBe('complete');
    const unstable = await inspectCoveredSnapshot(
      root,
      { timeoutMs: 10000 },
      {
        afterScan: async (attempt) => {
          await writeFile(file, String(attempt));
        },
      },
    );
    expect(unstable.attempts).toBe(3);
    expect(unstable.identity.coverage.status).toBe('unstable');
  });
  it('supports detached and unborn repositories with a separate versioned algorithm', async () => {
    const root = await repo();
    await git(root, 'checkout', '--detach');
    expect((await snapshot(root)).identity.coverage.status).toBe('complete');
    const unborn = await mkdtemp(path.join(os.tmpdir(), 'rirei-unborn-'));
    roots.push(unborn);
    await git(unborn, 'init', '--initial-branch=main');
    await writeFile(path.join(unborn, 'new'), 'x');
    const result = await snapshot(unborn);
    expect(result.identity.head).toBe('unborn');
    expect(result.identity.coverage.status).toBe('complete');
    expect(result.identity.algorithm).toBe('rirei-covered-inputs-v1');
  });
});
