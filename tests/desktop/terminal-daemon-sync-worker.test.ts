import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { TerminalDaemonClient } from '../../desktop/terminal-daemon-client.mjs';
import { runTerminalDaemon } from '../../desktop/terminal-daemon-server.mjs';
import {
  BRIDGE_WORKER_MAX_FRAME_BYTES,
  DaemonBridgeWorker,
} from '../../desktop/daemon-bridge-worker.mjs';

const roots: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
const entrypoint = fileURLToPath(
  new URL('../../src/index.ts', import.meta.url),
);
const tsxLoader = new URL(
  '../../node_modules/tsx/dist/loader.mjs',
  import.meta.url,
).href;

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
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

async function temporaryPaths() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rirei-sync-worker-test-'));
  roots.push(root);
  return {
    root,
    socketPath:
      process.platform === 'win32'
        ? `\\\\.\\pipe\\rirei-test-${randomUUID()}`
        : path.join(root, 'daemon.sock'),
    descriptorPath: path.join(root, 'daemon.json'),
  };
}

async function waitFor<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
) {
  const deadline = Date.now() + 10_000;
  let value = await read();
  while (!accept(value) && Date.now() < deadline) {
    await new Promise((resolve) => globalThis.setTimeout(resolve, 20));
    value = await read();
  }
  expect(accept(value)).toBe(true);
  return value;
}

describe('terminal daemon per-terminal sync queue', () => {
  test('coalesces pending heartbeat syncs while maintaining final > transition > heartbeat order', async () => {
    const { root, socketPath, descriptorPath } = await temporaryPaths();
    const calls: Array<{ status: string; id: string }> = [];
    let activeSyncs = 0;
    let maxActiveSyncs = 0;
    let resolveFirstSync: (() => void) | null = null;
    const firstSyncStarted = new Promise<void>((r) => {
      resolveFirstSync = r;
    });
    let releaseFirstSync: (() => void) | null = null;
    const firstSyncGate = new Promise<void>((resolve) => {
      releaseFirstSync = resolve;
    });

    let syncCount = 0;
    const daemon = await runTerminalDaemon({
      socketPath,
      descriptorPath,
      commandFor: () => [
        process.execPath,
        '-e',
        'process.stdin.resume(); process.on("SIGINT", () => process.exit(0)); setInterval(() => {}, 1000)',
      ],
      updateProviderStatus: async (
        _project: string,
        terminalId: string,
        observation: { status: string },
      ) => {
        activeSyncs += 1;
        maxActiveSyncs = Math.max(maxActiveSyncs, activeSyncs);
        calls.push({ status: observation.status, id: terminalId });
        syncCount += 1;
        try {
          if (syncCount === 1) {
            resolveFirstSync?.();
            await firstSyncGate;
          }
        } finally {
          activeSyncs -= 1;
        }
      },
    });
    cleanups.push(() => daemon.close({ stopActive: true }));

    const client = new TerminalDaemonClient({ descriptorPath, socketPath });
    await client.connect();
    cleanups.push(async () => client.disconnect());

    const terminal = await client.start({
      kind: 'agent',
      agent: 'antigravity',
      project: root,
      workspaceId: 'default',
    });

    await firstSyncStarted;

    try {
      await client.attach(terminal.id, 0);
      await client.acquireControl(terminal.id);
      await client.setWaiting(terminal.id, 'approval needed');
      await client.write(
        terminal.id,
        Buffer.from('continue').toString('base64'),
      );
      await client.setWaiting(terminal.id, 'another approval');

      const stopPromise = client.stop(terminal.id);
      releaseFirstSync?.();
      await stopPromise;
    } finally {
      releaseFirstSync?.();
    }

    await waitFor(
      async () => calls,
      (c) =>
        c.some(
          (item) => item.status === 'cancelled' || item.status === 'completed',
        ),
    );

    expect(maxActiveSyncs).toBe(1);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.length).toBeLessThanOrEqual(4);
    expect(['cancelled', 'completed']).toContain(
      calls[calls.length - 1]?.status,
    );
  });
});

describe('DaemonBridgeWorker', () => {
  test('reuses, validates, bounds, and restarts the worker child', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rirei-worker-test-'));
    roots.push(root);

    // Create a mock worker script that responds over stdio newline-delimited JSON
    const scriptPath = path.join(root, 'mock-worker.mjs');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      scriptPath,
      `import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  const msg = JSON.parse(line);
  if (msg.terminalId === 'exit-worker') process.exit(2);
  if (msg.terminalId === 'oversized-response') {
    process.stdout.write('x'.repeat(${BRIDGE_WORKER_MAX_FRAME_BYTES + 1}));
    continue;
  }
  const version = msg.terminalId === 'bad-version' ? 2 : 1;
  if (msg.terminalId === 'fail') {
    process.stdout.write(JSON.stringify({ v: version, id: msg.id, ok: false, error: 'simulated error' }) + '\\n');
  } else {
    process.stdout.write(JSON.stringify({ v: version, id: msg.id, ok: true }) + '\\n');
  }
}
`,
    );

    const worker = new DaemonBridgeWorker({
      nodePath: process.execPath,
      cliPath: scriptPath,
    });
    cleanups.push(async () => worker.stop());

    // Successful update
    await expect(
      worker.updateProviderStatus(root, 'term-ok', { status: 'running' }),
    ).resolves.toBeUndefined();
    const firstPid = worker.child?.pid;

    // Successful register
    await expect(
      worker.registerBridge(root, 'term-ok', {
        instanceId: 'inst-1',
        pid: 1234,
        protocolVersion: 1,
      }),
    ).resolves.toBeUndefined();
    expect(firstPid).toBeTypeOf('number');
    expect(worker.child?.pid).toBe(firstPid);

    // Handled failure
    await expect(
      worker.updateProviderStatus(root, 'fail', { status: 'failed' }),
    ).rejects.toThrow('simulated error');

    await expect(
      worker.updateProviderStatus(root, 'bad-version', {}),
    ).rejects.toThrow('Invalid bridge worker response.');
    await expect(
      worker.updateProviderStatus(root, 'term-too-large', {
        reason: 'x'.repeat(BRIDGE_WORKER_MAX_FRAME_BYTES),
      }),
    ).rejects.toThrow('Bridge worker request exceeds the size limit.');
    await expect(
      worker.updateProviderStatus(root, 'oversized-response', {}),
    ).rejects.toThrow('Bridge worker response exceeds the size limit.');
    await expect(
      worker.updateProviderStatus(root, 'after-oversized-response', {
        status: 'running',
      }),
    ).resolves.toBeUndefined();
    await expect(
      worker.updateProviderStatus(root, 'exit-worker', {}),
    ).rejects.toThrow('Bridge worker exited');
    await expect(
      worker.updateProviderStatus(root, 'after-restart', {
        status: 'running',
      }),
    ).resolves.toBeUndefined();

    // Stop terminates worker
    worker.stop();
    await expect(
      worker.updateProviderStatus(root, 'term-after-stop', {
        status: 'running',
      }),
    ).rejects.toThrow('Bridge worker is stopping');
  });

  test('rejects an oversized unterminated worker request before EOF', async () => {
    const child = spawn(
      process.execPath,
      ['--import', tsxLoader, entrypoint, 'bridge', '--worker'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    child.stdin.on('error', () => undefined);
    cleanups.push(
      () =>
        new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          child.once('close', () => resolve());
          child.kill('SIGKILL');
        }),
    );

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const closed = new Promise<number | null>((resolve) => {
      child.once('close', resolve);
    });
    let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = globalThis.setTimeout(
        () => reject(new Error('Bridge worker did not reject the frame.')),
        3_000,
      );
    });

    child.stdin.write(Buffer.alloc(BRIDGE_WORKER_MAX_FRAME_BYTES + 1, 0x78));
    const exitCode = await Promise.race([closed, deadline]).finally(() => {
      if (timeout) globalThis.clearTimeout(timeout);
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain('Bridge worker request exceeds the size limit.');
  });
});
