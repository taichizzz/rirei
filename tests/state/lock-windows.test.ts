import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { withDirectoryLock } from '../../src/state/lock.js';

const fault = vi.hoisted(() => ({ deniedGateRenames: 0 }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    async rename(
      source: Parameters<typeof actual.rename>[0],
      destination: Parameters<typeof actual.rename>[1],
    ) {
      if (
        fault.deniedGateRenames > 0 &&
        String(destination).endsWith('.gate')
      ) {
        fault.deniedGateRenames--;
        throw Object.assign(new Error('simulated Windows rename failure'), {
          code: 'EPERM',
        });
      }
      return actual.rename(source, destination);
    },
  };
});

async function simulateWindows(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'rirei-win-lock-'));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  try {
    await run(directory);
  } finally {
    Object.defineProperty(process, 'platform', platform);
    fault.deniedGateRenames = 0;
    await rm(directory, { recursive: true, force: true });
  }
}

describe('Windows lock publication', () => {
  it('can acquire after a rename loses a race with a gate that has already gone', async () => {
    await simulateWindows(async (directory) => {
      fault.deniedGateRenames = 1;
      const filesWhileOwned = await withDirectoryLock(directory, 'state', () =>
        readdir(directory),
      );
      expect(filesWhileOwned).toEqual(['state.lock']);
      expect(await readdir(directory)).toEqual([]);
    });
  });

  it('propagates a repeated permission error without running the protected callback or leaving claims', async () => {
    await simulateWindows(async (directory) => {
      fault.deniedGateRenames = 3;
      const update = vi.fn(async () => {});
      await expect(
        withDirectoryLock(directory, 'state', update),
      ).rejects.toMatchObject({ code: 'EPERM' });
      expect(update).not.toHaveBeenCalled();
      expect(await readdir(directory)).toEqual([]);
    });
  });
});
