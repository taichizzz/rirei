import { execFile } from 'node:child_process';
import { readFile, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CHECKPOINT_PATCH_DISPLAY_BYTES,
  listCheckpoints,
  readCheckpointDiff,
} from '../src/checkpoints.js';
import { createRepository, removeRepository } from './helpers.js';

const execFileAsync = promisify(execFile);
const directories: string[] = [];
const entrypoint = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const tsxLoader = new URL(
  '../node_modules/tsx/dist/loader.mjs',
  import.meta.url,
).href;

async function relay(
  cwd: string,
  ...args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(
    process.execPath,
    ['--import', tsxLoader, entrypoint, ...args],
    { cwd, encoding: 'utf8' },
  );
}

async function createCheckpoint(): Promise<{
  root: string;
  id: string;
  directory: string;
}> {
  const root = await createRepository();
  directories.push(root);
  await relay(root, 'init');
  await relay(root, 'start', 'Inspect saved work');
  await writeFile(path.join(root, 'README.md'), '# Changed\n');
  await writeFile(path.join(root, 'untracked.txt'), 'not captured\n');
  await relay(root, 'checkpoint', '--message', 'First view');
  const state = JSON.parse(
    await readFile(path.join(root, '.relay', 'state.json'), 'utf8'),
  ) as { checkpoints: Array<{ id: string }> };
  const id = state.checkpoints[0]!.id;
  return {
    root,
    id,
    directory: path.join(root, '.relay', 'checkpoints', id),
  };
}

async function rewriteMetadata(
  directory: string,
  update: (metadata: Record<string, unknown>) => void,
): Promise<void> {
  const metadataPath = path.join(directory, 'metadata.json');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<
    string,
    unknown
  >;
  update(metadata);
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeRepository));
});

describe('checkpoint artifact reader', () => {
  it('lists and reads initial schema-version-1 artifacts without changing Git', async () => {
    const { root, id } = await createCheckpoint();
    const beforeStatus = await execFileAsync(
      'git',
      ['status', '--porcelain=v1'],
      { cwd: root, encoding: 'utf8' },
    );
    const beforeHead = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    });

    await expect(listCheckpoints(root)).resolves.toEqual([
      {
        id,
        createdAt: expect.any(String),
        label: 'First view',
      },
    ]);
    const listed = JSON.parse(
      (await relay(root, 'checkpoints', '--json')).stdout,
    ) as { count: number; checkpoints: Array<Record<string, unknown>> };
    expect(listed).toMatchObject({
      count: 1,
      checkpoints: [{ id, label: 'First view' }],
    });

    const viewed = JSON.parse(
      (await relay(root, 'checkpoint-diff', id, '--json')).stdout,
    ) as Record<string, unknown>;
    expect(viewed).toMatchObject({
      metadata: {
        schemaVersion: 1,
        id,
        createdAt: expect.any(String),
        label: 'First view',
        commit: expect.any(String),
        branch: 'main',
        patchTruncated: false,
      },
      status: expect.stringContaining('untracked.txt'),
      diffStat: expect.any(String),
      patch: expect.stringContaining('# Changed'),
      captureTruncated: false,
      displayTruncated: false,
      warnings: expect.arrayContaining([
        expect.stringContaining('not a comparison between checkpoints'),
        expect.stringContaining('contents were not captured'),
      ]),
    });
    const human = await relay(root, 'checkpoint-diff', id);
    expect(human.stdout).toContain('# Changed');
    expect(human.stderr).toContain('not a comparison between checkpoints');
    expect(human.stderr).toContain('contents were not captured');

    const status = JSON.parse(
      (await relay(root, 'status', '--json')).stdout,
    ) as Record<string, unknown>;
    expect(status).toMatchObject({
      checkpointCount: 1,
      checkpoints: [{ id, label: 'First view' }],
    });
    const afterStatus = await execFileAsync(
      'git',
      ['status', '--porcelain=v1'],
      { cwd: root, encoding: 'utf8' },
    );
    const afterHead = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(afterStatus.stdout).toBe(beforeStatus.stdout);
    expect(afterHead.stdout).toBe(beforeHead.stdout);
  });

  it('reads retained checkpoints after task completion', async () => {
    const root = await createRepository();
    directories.push(root);
    await relay(root, 'init');
    await relay(root, 'start', 'Finish then inspect');
    await writeFile(path.join(root, 'README.md'), '# Completed change\n');
    await relay(root, 'finish');
    const state = JSON.parse(
      await readFile(path.join(root, '.relay', 'state.json'), 'utf8'),
    ) as { task: { status: string }; checkpoints: Array<{ id: string }> };
    const id = state.checkpoints[0]!.id;

    expect(state.task.status).toBe('completed');
    await expect(relay(root, 'checkpoints', '--json')).resolves.toMatchObject({
      stdout: expect.stringContaining(id),
    });
    const viewed = await relay(root, 'checkpoint-diff', id, '--json');
    expect(JSON.parse(viewed.stdout)).toMatchObject({
      metadata: { id },
      patch: expect.stringContaining('Completed change'),
    });
  });

  it('reads schema-version-1 checkpoint records and metadata without labels', async () => {
    const { root, id, directory } = await createCheckpoint();
    const statePath = path.join(root, '.relay', 'state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      checkpoints: Array<Record<string, unknown>>;
    };
    delete state.checkpoints[0]!.label;
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
    await rewriteMetadata(directory, (metadata) => {
      delete metadata.label;
    });

    await expect(listCheckpoints(root)).resolves.toEqual([
      { id, createdAt: expect.any(String) },
    ]);
    await expect(readCheckpointDiff(root, id)).resolves.toMatchObject({
      metadata: { schemaVersion: 1, id },
    });
  });

  it('rejects invalid, traversal, unknown, and pruned IDs', async () => {
    const { root, id } = await createCheckpoint();
    await expect(readCheckpointDiff(root, '../state.json')).rejects.toThrow(
      'Invalid Relay checkpoint ID',
    );
    await expect(readCheckpointDiff(root, 'not-a-checkpoint')).rejects.toThrow(
      'Invalid Relay checkpoint ID',
    );
    const unknown = '2099-01-01T00-00-00-000Z-999';
    await expect(readCheckpointDiff(root, unknown)).rejects.toThrow(
      'Unknown or pruned',
    );

    const statePath = path.join(root, '.relay', 'state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      checkpoints: unknown[];
    };
    state.checkpoints = [];
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
    await expect(readCheckpointDiff(root, id)).rejects.toThrow(
      'Unknown or pruned',
    );
  });

  it('rejects invalid IDs in current-state listings', async () => {
    const { root } = await createCheckpoint();
    const statePath = path.join(root, '.relay', 'state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      checkpoints: Array<{ id: string }>;
    };
    state.checkpoints[0]!.id = '../outside';
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
    await expect(listCheckpoints(root)).rejects.toThrow(
      'Invalid Relay checkpoint ID',
    );
  });

  it('rejects symlinked checkpoint directories and artifact files', async () => {
    const { root, id, directory } = await createCheckpoint();
    const target = `${directory}-target`;
    await rename(directory, target);
    await symlink(path.basename(target), directory);
    await expect(listCheckpoints(root)).rejects.toThrow('real directories');
    await expect(readCheckpointDiff(root, id)).rejects.toThrow(
      'real directories',
    );

    await unlink(directory);
    await rename(target, directory);
    const statusPath = path.join(directory, 'status.txt');
    await unlink(statusPath);
    await symlink(path.join(root, 'README.md'), statusPath);
    await expect(readCheckpointDiff(root, id)).rejects.toThrow('regular file');
  });

  it('rejects metadata whose ID does not match the selected checkpoint', async () => {
    const { root, id, directory } = await createCheckpoint();
    await rewriteMetadata(directory, (metadata) => {
      metadata.id = '2099-01-01T00-00-00-000Z-999';
    });
    await expect(readCheckpointDiff(root, id)).rejects.toThrow(
      'metadata ID does not match',
    );
  });

  it('omits binary patch bodies while leaving the saved artifact untouched', async () => {
    const { root, id, directory } = await createCheckpoint();
    const binaryPatch =
      'diff --git a/image.png b/image.png\nGIT binary patch\nliteral 3\nabc\n';
    const patchPath = path.join(directory, 'changes.patch');
    await writeFile(patchPath, binaryPatch);

    const viewed = await readCheckpointDiff(root, id);
    expect(viewed.patch).toContain('[Relay binary patch omitted]');
    expect(viewed.patch).not.toContain('literal 3');
    expect(viewed.warnings).toContain(
      'The saved patch contains binary data; its patch body was omitted.',
    );
    const json = JSON.parse(
      (await relay(root, 'checkpoint-diff', id, '--json')).stdout,
    ) as { patch: string; warnings: string[] };
    expect(json.patch).toContain('[Relay binary patch omitted]');
    expect(json.warnings).toContain(
      'The saved patch contains binary data; its patch body was omitted.',
    );
    await expect(readFile(patchPath, 'utf8')).resolves.toBe(binaryPatch);
  });

  it('keeps text sections when a separate binary section is omitted', async () => {
    const { root, id, directory } = await createCheckpoint();
    await writeFile(
      path.join(directory, 'changes.patch'),
      'diff --git a/readme.md b/readme.md\n@@ -1 +1 @@\n-old\n+GIT binary patch\ndiff --git a/image.png b/image.png\nGIT binary patch\nliteral 3\nabc\n',
    );
    const viewed = await readCheckpointDiff(root, id);
    expect(viewed.patch).toContain('+GIT binary patch');
    expect(viewed.patch).toContain('[Relay binary patch omitted]');
    expect(viewed.patch).not.toContain('literal 3');
  });

  it('reports capture and display truncation separately with valid UTF-8', async () => {
    const { root, id, directory } = await createCheckpoint();
    const patchPath = path.join(directory, 'changes.patch');
    await rewriteMetadata(directory, (metadata) => {
      metadata.patchTruncated = true;
    });
    await writeFile(patchPath, 'captured prefix\n');

    const captureTruncated = await readCheckpointDiff(root, id);
    expect(captureTruncated).toMatchObject({
      patch: 'captured prefix\n',
      captureTruncated: true,
      displayTruncated: false,
    });
    expect(captureTruncated.warnings).toContain(
      'The patch was truncated when this checkpoint was captured.',
    );

    await rewriteMetadata(directory, (metadata) => {
      metadata.patchTruncated = false;
    });
    await writeFile(
      patchPath,
      `${'x'.repeat(CHECKPOINT_PATCH_DISPLAY_BYTES - 1)}é`,
    );
    const displayTruncated = await readCheckpointDiff(root, id);
    expect(displayTruncated.captureTruncated).toBe(false);
    expect(displayTruncated.displayTruncated).toBe(true);
    expect(Buffer.byteLength(displayTruncated.patch)).toBeLessThanOrEqual(
      CHECKPOINT_PATCH_DISPLAY_BYTES,
    );
    expect(displayTruncated.patch).not.toContain('�');
    expect(displayTruncated.patch.endsWith('x')).toBe(true);
    expect(displayTruncated.warnings).toContain(
      'The returned patch was truncated for display.',
    );
  });
});
