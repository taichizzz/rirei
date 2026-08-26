import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TerminalDaemonClient } from '../../desktop/terminal-daemon-client.mjs';
import { ensureDaemon } from '../../src/platform/daemon-manager.js';

const roots: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true })));
});

async function temporaryPaths() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rirei-cli-daemon-test-'));
  roots.push(root);
  return {
    root,
    socketPath:
      process.platform === 'win32'
        ? `\\\\.\\pipe\\rirei-cli-test-${randomUUID()}`
        : path.join(root, 'daemon.sock'),
    descriptorPath: path.join(root, 'daemon.json'),
  };
}

describe('CLI daemon launcher', () => {
  it('starts the daemon process via internal CLI flag and accepts client connections', async () => {
    const { root, socketPath, descriptorPath } = await temporaryPaths();
    const cliPath = path.resolve('dist/index.cjs');

    const daemonProc = spawn(
      process.execPath,
      [
        cliPath,
        'daemon',
        '--internal',
        '--socket',
        socketPath,
        '--descriptor',
        descriptorPath,
        '--cli',
        cliPath,
        '--node',
        process.execPath,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    cleanups.push(async () => {
      try {
        process.kill(daemonProc.pid!, 'SIGTERM');
      } catch {
        // already stopped
      }
    });

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        const stats = await lstat(descriptorPath);
        if (stats.isFile()) break;
      } catch {
        // wait
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    const client = new TerminalDaemonClient({
      descriptorPath,
      socketPath,
      requestTimeoutMs: 3000,
    });

    await client.connect();
    expect(client.connected).toBe(true);

    const terminal = await client.start({
      kind: 'shell',
      project: root,
      workspaceId: 'default',
    });

    expect(terminal.id).toBeDefined();
    expect(terminal.status).toBe('running');

    client.disconnect();
    daemonProc.kill('SIGTERM');
  });

  it('ensureDaemon starts a new daemon or reuses an existing healthy daemon', async () => {
    const { root } = await temporaryPaths();
    const cliPath = path.resolve('dist/index.cjs');

    // First call: spawns new daemon
    const firstResult = await ensureDaemon({
      runtimeRoot: root,
      cliPath,
      nodePath: process.execPath,
      timeoutMs: 5000,
    });

    expect(firstResult.reused).toBe(false);
    expect(firstResult.socketPath).toBeDefined();
    expect(firstResult.descriptorPath).toBeDefined();
    const descriptor = JSON.parse(
      await readFile(firstResult.descriptorPath, 'utf8'),
    );
    cleanups.push(async () => {
      try {
        process.kill(descriptor.pid, 'SIGTERM');
      } catch {
        // Already stopped.
      }
    });

    // Second call: reuses existing healthy daemon
    const secondResult = await ensureDaemon({
      runtimeRoot: root,
      cliPath,
      nodePath: process.execPath,
      timeoutMs: 5000,
    });

    expect(secondResult.reused).toBe(true);
    expect(secondResult.socketPath).toBe(firstResult.socketPath);
  });
});
