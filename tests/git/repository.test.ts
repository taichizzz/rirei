import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  discoverRepository,
  inspectGitBaseline,
} from '../../src/git/repository.js';
import { createRepository, removeRepository } from '../helpers.js';

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
});
