import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  initializeProject,
  inspectProjectSetup,
  startTask,
} from '../../src/application/project-setup.js';
import { readState } from '../../src/state/store.js';
import { createRepository, removeRepository } from '../helpers.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((root) => removeRepository(root)),
  );
});
async function repository() {
  const root = await createRepository();
  directories.push(root);
  return root;
}

describe('shared project setup', () => {
  it('inspects a first launch without creating state and initializes only on request', async () => {
    const root = await repository();
    expect(await inspectProjectSetup(root)).toMatchObject({
      stage: 'initialize',
    });
    await expect(access(path.join(root, '.relay'))).rejects.toHaveProperty(
      'code',
      'ENOENT',
    );
    await initializeProject(root);
    expect(await inspectProjectSetup(root)).toMatchObject({
      stage: 'task',
      dirty: false,
    });
    const config = await readFile(
      path.join(root, '.relay', 'config.json'),
      'utf8',
    );
    await expect(initializeProject(root)).rejects.toThrow(
      'refusing to overwrite',
    );
    expect(
      await readFile(path.join(root, '.relay', 'config.json'), 'utf8'),
    ).toBe(config);
  });

  it('starts a task and leaves an existing active task intact on later launches', async () => {
    const root = await repository();
    await initializeProject(root);
    const created = await startTask(
      root,
      'Implement a Windows terminal feature',
    );
    expect(await inspectProjectSetup(root)).toMatchObject({
      stage: 'ready',
      taskTitle: created.task.title,
    });
    const before = await readState(root);
    await expect(startTask(root, 'Replace it')).rejects.toThrow(
      'active Relay task',
    );
    expect(await readState(root)).toEqual(before);
  });

  it('requires an explicit dirty baseline acknowledgement and preserves the source change', async () => {
    const root = await repository();
    await initializeProject(root);
    const file = path.join(root, 'unfinished.txt');
    await writeFile(file, 'existing work\n');
    expect(await inspectProjectSetup(root)).toMatchObject({
      stage: 'task',
      dirty: true,
    });
    await expect(startTask(root, 'Continue work')).rejects.toThrow(
      '--allow-dirty',
    );
    const created = await startTask(root, 'Continue work', {
      allowDirty: true,
    });
    expect(created.git.dirtyAtStart).toBe(true);
    expect(await readFile(file, 'utf8')).toBe('existing work\n');
  });

  it('shows invalid settings as an error without resetting them', async () => {
    const root = await repository();
    await initializeProject(root);
    const config = path.join(root, '.relay', 'config.json');
    await writeFile(config, '{broken');
    expect(await inspectProjectSetup(root)).toMatchObject({ stage: 'error' });
    expect(await readFile(config, 'utf8')).toBe('{broken');
  });

  it('does not create a Git repository for an ordinary directory', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'rirei-no-git-'));
    try {
      expect(await inspectProjectSetup(root)).toMatchObject({
        stage: 'not_repository',
      });
      await expect(access(path.join(root, '.git'))).rejects.toHaveProperty(
        'code',
        'ENOENT',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
