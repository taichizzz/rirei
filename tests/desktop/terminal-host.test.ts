import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTerminalHost } from '../../desktop/terminal-host.mjs';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 100,
      }),
    ),
  );
});

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 25));
  expect(check()).toBe(true);
}

describe('desktop node-pty terminal host', () => {
  it('resolves node-pty from the module location instead of cwd', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rirei-host-cwd-'));
    roots.push(root);
    const original = process.cwd();
    process.chdir(root);
    try {
      const host = await createTerminalHost(
        process.execPath,
        ['-e', 'process.stdout.write("resolved"); setTimeout(() => {}, 100)'],
        { cwd: root, env: process.env },
      );
      let output = '';
      host.onData((data: Uint8Array) => {
        output += Buffer.from(data).toString('utf8');
      });
      await new Promise<void>((resolve) => host.onExit(() => resolve()));
      expect(output).toContain('resolved');
    } finally {
      process.chdir(original);
    }
  });

  it('force-kills the PTY process tree', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rirei-host-tree-'));
    roots.push(root);
    const script = [
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "console.log('CHILD_PID=' + child.pid);",
      'setInterval(() => {}, 1000);',
    ].join('');
    const host = await createTerminalHost(process.execPath, ['-e', script], {
      cwd: root,
      env: process.env,
    });
    let output = '';
    let childPid = 0;
    host.onData((data: Uint8Array) => {
      output += Buffer.from(data).toString('utf8');
      const match = /CHILD_PID=(\d+)/.exec(output);
      if (match?.[1]) childPid = Number(match[1]);
    });
    await waitFor(() => childPid > 0 && alive(childPid));
    await host.killTree();
    await waitFor(() => !alive(host.pid) && !alive(childPid));
  });
});
