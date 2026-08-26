import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  killProcessTree,
  processIsAlive,
} from '../../src/platform/process-control.js';

describe('process control', () => {
  it('reports current process as alive', () => {
    expect(processIsAlive(process.pid)).toBe(true);
  });

  it('reports invalid or nonexistent PIDs as not alive', () => {
    expect(processIsAlive(0)).toBe(false);
    expect(processIsAlive(-1)).toBe(false);
    expect(processIsAlive(99999999)).toBe(false);
  });

  it('handles killProcessTree gracefully for invalid or already-exited processes', async () => {
    await expect(
      killProcessTree(99999999, { platform: 'win32' }),
    ).resolves.toBeUndefined();
    await expect(
      killProcessTree(99999999, { platform: 'darwin' }),
    ).resolves.toBeUndefined();
    await expect(killProcessTree(-1)).resolves.toBeUndefined();
  });

  it('terminates a single spawned process', async () => {
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      {
        stdio: 'ignore',
      },
    );
    const pid = child.pid!;
    expect(processIsAlive(pid)).toBe(true);

    await killProcessTree(pid);

    const deadline = Date.now() + 3000;
    while (processIsAlive(pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(processIsAlive(pid)).toBe(false);
  });

  it('terminates a multi-process tree completely', async () => {
    const parent = spawn(
      process.execPath,
      [
        '-e',
        `
        const { spawn } = require('node:child_process');
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'pipe' });
        child.stdout.resume();
        console.log(child.pid);
        setInterval(() => {}, 1000);
      `,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );

    const parentPid = parent.pid!;
    expect(processIsAlive(parentPid)).toBe(true);

    const childPid = await new Promise<number>((resolve) => {
      parent.stdout!.once('data', (data) => {
        const raw = data.toString('utf8').trim();
        resolve(Number.parseInt(raw, 10));
      });
    });

    expect(processIsAlive(childPid)).toBe(true);

    await killProcessTree(parentPid);

    const deadline = Date.now() + 3000;
    while (
      (processIsAlive(parentPid) || processIsAlive(childPid)) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(processIsAlive(parentPid)).toBe(false);
    expect(processIsAlive(childPid)).toBe(false);
  });
});
