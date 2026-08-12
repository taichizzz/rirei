import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveWorkspacePath } from '../src/index.js';

test('resolves safe existing and missing workspace paths', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-public-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  const canonical = await realpath(root);
  assert.equal(await resolveWorkspacePath(root, 'src'), join(canonical, 'src'));
  assert.equal(
    await resolveWorkspacePath(root, 'src/new/file.js'),
    join(canonical, 'src/new/file.js'),
  );
});

test('rejects lexical escapes and invalid candidates', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-public-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const candidate of [
    '',
    '../outside',
    'safe/../../outside',
    '/absolute',
    'bad\0name',
  ]) {
    await assert.rejects(
      resolveWorkspacePath(root, candidate),
      undefined,
      candidate,
    );
  }
});
