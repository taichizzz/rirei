import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveWorkspacePath } from '../src/index.js';

async function fixture(context) {
  const parent = await mkdtemp(join(tmpdir(), 'workspace-hidden-'));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, 'work');
  const outside = join(parent, 'work-evil');
  await mkdir(join(root, 'real'), { recursive: true });
  await mkdir(outside);
  await symlink('real', join(root, 'inside-link'));
  await symlink(outside, join(root, 'outside-link'));
  await symlink('missing-target', join(root, 'broken-link'));
  await writeFile(join(root, 'file'), 'x');
  return { root, outside };
}

test('allows an in-root symlink and canonicalizes its missing tail', async (context) => {
  const { root } = await fixture(context);
  const canonical = await realpath(root);
  assert.equal(
    await resolveWorkspacePath(root, 'inside-link/new.js'),
    join(canonical, 'real/new.js'),
  );
});

test('rejects outside, broken, and non-directory components', async (context) => {
  const { root } = await fixture(context);
  await assert.rejects(resolveWorkspacePath(root, 'outside-link/secret'));
  await assert.rejects(resolveWorkspacePath(root, 'broken-link/child'));
  await assert.rejects(resolveWorkspacePath(root, 'file/child'));
});

test('does not confuse a sibling prefix with root containment', async (context) => {
  const { root, outside } = await fixture(context);
  await symlink(outside, join(root, 'prefix-trap'));
  await assert.rejects(resolveWorkspacePath(root, 'prefix-trap'));
});
