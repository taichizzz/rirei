import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmod, lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  isSafeDaemonDescriptorFile,
  TerminalDaemonClient,
} from '../../desktop/terminal-daemon-client.mjs';
import {
  DaemonFrameDecoder,
  encodeDaemonFrame,
} from '../../desktop/terminal-daemon-protocol.mjs';
import { runTerminalDaemon } from '../../desktop/terminal-daemon-server.mjs';

const roots: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
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
  const root = await mkdtemp(path.join(os.tmpdir(), 'rirei-daemon-test-'));
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

async function startDaemon(
  commandFor = () =>
    process.platform === 'win32'
      ? [process.env.ComSpec || 'cmd.exe']
      : ['/bin/zsh', '-f'],
  overrides: Record<string, unknown> = {},
) {
  const paths = await temporaryPaths();
  const daemon = await runTerminalDaemon({
    ...paths,
    bridgePath: path.resolve('desktop/pty_bridge.py'),
    pathValue: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
    commandFor,
    readProviderResult: async () => null,
    ...overrides,
  });
  cleanups.push(() => daemon.close({ stopActive: true }));
  return { ...paths, daemon };
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

function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    if (process.platform !== 'win32') {
      const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], {
        encoding: 'utf8',
      }).stdout.trim();
      if (!state || state.startsWith('Z')) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function welcome(socketPath: string, token: string) {
  const socket = net.createConnection(socketPath);
  await once(socket, 'connect');
  const decoder = new DaemonFrameDecoder();
  const frame = new Promise<Record<string, unknown>>((resolve, reject) => {
    socket.on('data', (chunk) => {
      try {
        const welcomeFrame = decoder.push(chunk)[0];
        if (welcomeFrame) resolve(welcomeFrame);
      } catch (error) {
        reject(error);
      }
    });
    socket.once('error', reject);
  });
  socket.write(
    encodeDaemonFrame({
      type: 'hello',
      token,
      clientId: randomUUID(),
      pid: process.pid,
    }),
  );
  return { socket, frame: await frame };
}

describe('terminal daemon', () => {
  test('uses platform-aware descriptor permission checks', () => {
    const descriptor = {
      isFile: () => true,
      isSymbolicLink: () => false,
      mode: 0o100666,
      uid: 501,
    };
    expect(isSafeDaemonDescriptorFile(descriptor, 'win32')).toBe(true);
    expect(isSafeDaemonDescriptorFile(descriptor, 'darwin', 501)).toBe(false);
  });

  test('authenticates the reconnect token before accepting requests', async () => {
    const { daemon, socketPath } = await startDaemon();
    const rejected = net.createConnection(socketPath);
    await once(rejected, 'connect');
    rejected.write(
      encodeDaemonFrame({
        type: 'hello',
        token: 'invalid-token',
        clientId: randomUUID(),
        pid: process.pid,
      }),
    );

    await once(rejected, 'close');
    expect(rejected.bytesRead).toBe(0);

    const authenticated = await welcome(socketPath, daemon.token);
    expect(authenticated.frame).toMatchObject({
      type: 'welcome',
      daemonId: daemon.daemonId,
    });
    authenticated.socket.destroy();
    await daemon.close({ stopActive: false });
  });

  test('replays bounded slices and reports output truncated from the ring', async () => {
    const outputBytes = 2 * 1024 * 1024 + 1024;
    const outputCompleteMarker = 'RIREI_OUTPUT_COMPLETE';
    const { daemon, descriptorPath, root, socketPath } = await startDaemon(
      () => [
        process.execPath,
        '-e',
        `process.stdout.write(Buffer.alloc(${outputBytes}, 97)); process.stdout.write('${outputCompleteMarker}'); setInterval(() => {}, 1000)`,
      ],
    );
    const firstClient = new TerminalDaemonClient({
      descriptorPath,
      socketPath,
      requestTimeoutMs: 2_000,
    });
    await firstClient.connect();
    const terminal = await firstClient.start({
      kind: 'shell',
      project: root,
      workspaceId: 'default',
    });
    await waitFor(
      () => firstClient.inspect(terminal.id),
      (item) => item.nextCursor >= outputBytes,
    );
    await waitFor(
      () => firstClient.attach(terminal.id, outputBytes),
      (item) =>
        Buffer.from(item.data, 'base64')
          .toString('utf8')
          .includes(outputCompleteMarker),
    );

    const first = await firstClient.attach(terminal.id, 0);
    expect(first).toMatchObject({
      requestedCursor: 0,
      truncated: true,
      startCursor: first.oldestCursor,
    });
    expect(first.oldestCursor).toBeGreaterThan(0);
    expect(Buffer.from(first.data, 'base64')).toHaveLength(64 * 1024);

    const second = await firstClient.attach(terminal.id, first.endCursor);
    expect(second.startCursor).toBe(first.endCursor);
    expect(second.endCursor).toBeGreaterThan(second.startCursor);

    const replayed = await firstClient.attach(terminal.id, second.endCursor);
    const replayedAgain = await firstClient.attach(
      terminal.id,
      second.endCursor,
    );
    expect(replayedAgain).toMatchObject({
      startCursor: replayed.startCursor,
      endCursor: replayed.endCursor,
      data: replayed.data,
    });

    firstClient.disconnect();
    const restartedMainClient = new TerminalDaemonClient({
      descriptorPath,
      socketPath,
      requestTimeoutMs: 2_000,
    });
    await restartedMainClient.connect();
    expect(restartedMainClient.inventory.get(terminal.id)).toMatchObject({
      id: terminal.id,
    });
    await expect(
      restartedMainClient.write(terminal.id, 'x'),
    ).rejects.toMatchObject({ code: 'not_attached' });
    const reattached = await restartedMainClient.attach(
      terminal.id,
      second.endCursor,
    );
    expect(reattached.startCursor).toBe(
      Math.max(second.endCursor, reattached.oldestCursor),
    );
    await expect(
      restartedMainClient.setWaiting(terminal.id),
    ).resolves.toMatchObject({ status: 'waiting' });
    await expect(restartedMainClient.write(terminal.id, 'x')).resolves.toEqual({
      ok: true,
    });
    await expect(
      restartedMainClient.inspect(terminal.id),
    ).resolves.toMatchObject({ status: 'running' });
    await restartedMainClient.setHidden(terminal.id, true);
    expect(restartedMainClient.inventory.get(terminal.id)).toMatchObject({
      hidden: true,
    });

    await restartedMainClient.stop(terminal.id);
    await waitFor(
      () => restartedMainClient.inspect(terminal.id),
      (item) => ['completed', 'failed', 'cancelled'].includes(item.status),
    );
    await restartedMainClient.forget(terminal.id);
    expect(restartedMainClient.inventory.has(terminal.id)).toBe(false);
    restartedMainClient.disconnect();
    await daemon.close({ stopActive: false });
  });

  test('pauses Antigravity on permission output and resumes on input', async () => {
    const transitions: Array<Record<string, unknown>> = [];
    const { daemon, descriptorPath, root, socketPath } = await startDaemon(
      () => [
        process.execPath,
        '-e',
        `process.stdin.resume(); process.stdout.write('Requesting your per'); setTimeout(() => process.stdout.write('mission in Terminal:'), 20); setInterval(() => {}, 1000)`,
      ],
      {
        updateProviderStatus: async (
          _project: string,
          _terminalId: string,
          observation: Record<string, unknown>,
        ) => transitions.push(observation),
      },
    );
    const client = new TerminalDaemonClient({ descriptorPath, socketPath });
    await client.connect();
    const terminal = await client.start({
      kind: 'agent',
      agent: 'antigravity',
      project: root,
      workspaceId: 'default',
    });
    const waiting = await waitFor(
      () => client.inspect(terminal.id),
      (item) => item.status === 'waiting',
    );
    expect(waiting).toMatchObject({
      lifecycleState: 'needs_permission',
      attentionKind: 'permission',
    });
    await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
    const stillWaiting = await client.inspect(terminal.id);
    expect(stillWaiting.activeRuntimeSeconds).toBeCloseTo(
      waiting.activeRuntimeSeconds,
      6,
    );
    expect(transitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'waiting',
          lifecycleState: 'needs_permission',
          attentionKind: 'permission',
        }),
      ]),
    );

    await client.attach(terminal.id, 0);
    await client.write(terminal.id, 'y');
    const resumed = await waitFor(
      () => client.inspect(terminal.id),
      (item) => item.status === 'running',
    );
    await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
    expect(
      (await client.inspect(terminal.id)).activeRuntimeSeconds,
    ).toBeGreaterThan(resumed.activeRuntimeSeconds + 0.05);
    expect(transitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'waiting' }),
        expect.objectContaining({
          status: 'running',
          lifecycleState: 'working',
          attentionKind: null,
        }),
      ]),
    );
    client.disconnect();
    await daemon.close({ stopActive: true });
  });

  test('normalizes explicit lifecycle signals for structured providers', async () => {
    const { daemon, descriptorPath, root, socketPath } = await startDaemon(
      () => [
        process.execPath,
        '-e',
        `process.stdin.on('data', () => process.stdout.write('\u0007')); setInterval(() => {}, 1000)`,
      ],
    );
    const client = new TerminalDaemonClient({ descriptorPath, socketPath });
    await client.connect();
    for (const provider of ['claude', 'codex', 'opencode']) {
      const terminal = await client.start({
        kind: 'agent',
        agent: provider,
        project: root,
        workspaceId: provider,
      });
      await waitFor(
        () => client.inspect(terminal.id),
        (item) => item.status === 'running',
      );
      await expect(
        client.setLifecycle(terminal.id, 'needs_permission'),
      ).resolves.toMatchObject({
        status: 'waiting',
        lifecycleState: 'needs_permission',
        attentionKind: 'permission',
      });
      await client.attach(terminal.id, 0);
      await client.setWaiting(terminal.id, 'input');
      await client.write(terminal.id, 'navigation-key');
      await new Promise((resolve) => globalThis.setTimeout(resolve, 50));
      await expect(client.inspect(terminal.id)).resolves.toMatchObject({
        status: 'waiting',
        lifecycleState: 'needs_permission',
        attentionKind: 'permission',
      });
      await expect(
        client.setLifecycle(terminal.id, 'waiting_for_input'),
      ).resolves.toMatchObject({
        status: 'waiting',
        lifecycleState: 'waiting_for_input',
        attentionKind: 'input',
      });
      await expect(
        client.setLifecycle(terminal.id, 'working'),
      ).resolves.toMatchObject({
        status: 'running',
        lifecycleState: 'working',
        attentionKind: null,
      });
    }
    client.disconnect();
    await daemon.close({ stopActive: true });
  });

  test('does not let delayed lifecycle reports revive a stopping terminal', async () => {
    const { daemon, descriptorPath, root, socketPath } = await startDaemon(
      () => [
        process.execPath,
        '-e',
        `process.on('SIGINT', () => {}); process.on('SIGTERM', () => {}); process.stdout.write('READY'); setInterval(() => {}, 1000)`,
      ],
    );
    const client = new TerminalDaemonClient({ descriptorPath, socketPath });
    await client.connect();
    const terminal = await client.start({
      kind: 'agent',
      agent: 'codex',
      project: root,
      workspaceId: 'default',
    });
    await waitFor(
      () => client.inspect(terminal.id),
      (item) => item.status === 'running',
    );
    await waitFor(
      () => client.attach(terminal.id, 0),
      (item) => Buffer.from(item.data, 'base64').includes('READY'),
    );

    await client.stop(terminal.id);
    await expect(
      client.setLifecycle(terminal.id, 'working'),
    ).resolves.toMatchObject({ status: 'stopping' });
    await expect(client.inspect(terminal.id)).resolves.toMatchObject({
      status: 'stopping',
      lifecycleState: 'stopping',
    });

    client.disconnect();
    await daemon.close({ stopActive: true });
  });

  test('awaits bounded process-tree shutdown before daemon close returns', async () => {
    const script = [
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "console.log('CHILD_PID=' + child.pid);",
      "process.on('SIGTERM', () => {});",
      'setInterval(() => {}, 1000);',
    ].join('');
    const { daemon, descriptorPath, root, socketPath } = await startDaemon(
      () => [process.execPath, '-e', script],
      {
        stopTerminateMs: 50,
        stopKillMs: 100,
        shutdownTimeoutMs: 1000,
      },
    );
    const client = new TerminalDaemonClient({ descriptorPath, socketPath });
    await client.connect();
    const terminal = await client.start({
      kind: 'shell',
      project: root,
      workspaceId: 'default',
    });
    const running = await waitFor(
      () => client.inspect(terminal.id),
      (item) => item.status === 'running',
    );
    const replay = await waitFor(
      () => client.attach(terminal.id, 0),
      (item) =>
        /CHILD_PID=(\d+)/.test(
          Buffer.from(item.data, 'base64').toString('utf8'),
        ),
    );
    const childPid = Number.parseInt(
      Buffer.from(replay.data, 'base64')
        .toString('utf8')
        .match(/CHILD_PID=(\d+)/)?.[1] ?? '0',
      10,
    );
    expect(childPid).toBeGreaterThan(0);
    expect(processAlive(running.bridge.pid)).toBe(true);
    expect(processAlive(childPid)).toBe(true);
    client.disconnect();

    const startedAt = Date.now();
    await daemon.close({ stopActive: true });
    expect(Date.now() - startedAt).toBeLessThan(2000);
    await waitFor(
      async () => ({
        root: processAlive(running.bridge.pid),
        child: processAlive(childPid),
      }),
      (alive) => !alive.root && !alive.child,
    );
  });

  test('retries bridge registration until run state is ready', async () => {
    let attempts = 0;
    const { daemon, descriptorPath, root, socketPath } = await startDaemon(
      () => [process.execPath, '-e', `setInterval(() => {}, 1000)`],
      {
        bridgeRegistrationRetryMs: 10,
        registerBridge: async () => {
          attempts += 1;
          if (attempts < 4) throw new Error('Run is not ready.');
        },
      },
    );
    const client = new TerminalDaemonClient({ descriptorPath, socketPath });
    await client.connect();
    const terminal = await client.start({
      kind: 'agent',
      agent: 'codex',
      project: root,
      workspaceId: 'default',
    });

    await waitFor(
      async () => attempts,
      (value) => value >= 4,
    );
    expect((await client.inspect(terminal.id)).bridgeError).toBeNull();

    client.disconnect();
    await daemon.close({ stopActive: true });
  });

  test('accepts only the owning terminal lifecycle hook token', async () => {
    const { daemon, descriptorPath, root, socketPath } = await startDaemon(
      () => [
        process.execPath,
        '-e',
        `process.stdin.resume(); setInterval(() => {}, 1000)`,
      ],
    );
    const client = new TerminalDaemonClient({ descriptorPath, socketPath });
    await client.connect();
    const terminal = await client.start({
      kind: 'agent',
      agent: 'claude',
      project: root,
      workspaceId: 'default',
    });
    await waitFor(
      () => client.inspect(terminal.id),
      (item) => item.status === 'running',
    );
    const internal = daemon.terminals.get(terminal.id)!;
    const report = (lifecycleState: string, token: string) =>
      new Promise<void>((resolve) => {
        const child = spawn(
          process.execPath,
          [path.resolve('desktop/provider-lifecycle-hook.cjs'), lifecycleState],
          {
            env: {
              ...process.env,
              RIREI_LIFECYCLE_SOCKET: socketPath,
              RIREI_TERMINAL_ID: terminal.id,
              RIREI_LIFECYCLE_TOKEN: token,
            },
            stdio: 'ignore',
          },
        );
        child.once('error', () => resolve());
        child.once('close', () => resolve());
      });

    await report('needs_permission', 'invalid-token');
    expect((await client.inspect(terminal.id)).lifecycleState).toBe('working');
    await report('needs_permission', internal.lifecycleToken);
    expect(await client.inspect(terminal.id)).toMatchObject({
      lifecycleState: 'needs_permission',
      attentionKind: 'permission',
    });
    await report('waiting_for_input', internal.lifecycleToken);
    expect(await client.inspect(terminal.id)).toMatchObject({
      lifecycleState: 'waiting_for_input',
      attentionKind: 'input',
    });
    await report('working', internal.lifecycleToken);
    expect(await client.inspect(terminal.id)).toMatchObject({
      lifecycleState: 'working',
      attentionKind: null,
    });
    client.disconnect();
    await daemon.close({ stopActive: true });
  });

  test('validates descriptors and times out unanswered requests', async () => {
    const { descriptorPath, socketPath } = await temporaryPaths();
    const daemonId = randomUUID();
    const reconnectToken = 'a'.repeat(43);
    await writeFile(
      descriptorPath,
      JSON.stringify({
        schemaVersion: 1,
        protocolVersion: 1,
        daemonId,
        pid: process.pid,
        socketPath,
        reconnectToken,
        createdAt: new Date().toISOString(),
      }),
    );
    if (process.platform !== 'win32') await chmod(descriptorPath, 0o600);
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      const decoder = new DaemonFrameDecoder();
      socket.on('data', (chunk) => {
        for (const frame of decoder.push(chunk)) {
          if (frame.type === 'hello') {
            socket.write(
              encodeDaemonFrame({
                type: 'welcome',
                daemonId,
                pid: process.pid,
              }),
            );
          } else if (
            frame.type === 'request' &&
            frame.op === 'list' &&
            frame.id === '1'
          ) {
            socket.write(
              encodeDaemonFrame({
                type: 'response',
                id: frame.id,
                ok: true,
                body: [],
              }),
            );
          }
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    cleanups.push(async () => {
      for (const socket of sockets) socket.destroy();
      if (server.listening)
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const client = new TerminalDaemonClient({
      descriptorPath,
      socketPath,
      requestTimeoutMs: 50,
    });
    await client.connect();

    await expect(client.list()).rejects.toMatchObject({
      daemonCode: 'request_timeout',
    });
    expect(client.pending.size).toBe(0);
    client.disconnect();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );

    const invalidClient = new TerminalDaemonClient({
      descriptorPath,
      socketPath: `${socketPath}.other`,
    });
    await expect(invalidClient.connect()).rejects.toThrow(/descriptor/);
  });

  test('stops bridge descendants when the daemon crashes', async () => {
    const { root, socketPath, descriptorPath } = await temporaryPaths();
    const daemonProcess = spawn(
      process.execPath,
      [
        path.resolve('desktop/terminal-daemon.mjs'),
        '--socket',
        socketPath,
        '--descriptor',
        descriptorPath,
        '--bridge',
        path.resolve('desktop/pty_bridge.py'),
        '--cli',
        path.resolve('dist/index.cjs'),
        '--node',
        process.execPath,
      ],
      { stdio: 'ignore' },
    );
    cleanups.push(async () => {
      if (processAlive(daemonProcess.pid!)) daemonProcess.kill('SIGKILL');
    });
    await waitFor(async () => {
      try {
        await lstat(descriptorPath);
        return true;
      } catch {
        return false;
      }
    }, Boolean);
    const client = new TerminalDaemonClient({ descriptorPath, socketPath });
    await client.connect();
    const terminal = await client.start({
      kind: 'shell',
      project: root,
      workspaceId: 'default',
      shell:
        process.platform === 'win32'
          ? process.env.ComSpec || 'cmd.exe'
          : '/bin/zsh',
    });
    const running = await waitFor(
      () => client.inspect(terminal.id),
      (item) => Boolean(item.bridge?.pid && item.bridge?.childPid),
    );
    const disconnected = once(client, 'disconnected');
    daemonProcess.kill('SIGKILL');
    await disconnected;

    const deadline = Date.now() + 10_000;
    while (
      (processAlive(running.bridge.pid) ||
        processAlive(running.bridge.childPid)) &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 20));
    if (
      processAlive(running.bridge.pid) ||
      processAlive(running.bridge.childPid)
    ) {
      const details = spawnSync(
        'ps',
        [
          '-o',
          'pid=,ppid=,pgid=,stat=,command=',
          '-p',
          String(running.bridge.pid),
        ],
        { encoding: 'utf8' },
      ).stdout.trim();
      throw new Error(`Daemon-owned PTY survived daemon crash: ${details}`);
    }
    client.disconnect();
  });
});
