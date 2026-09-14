import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { TerminalDaemonClient } from '../../desktop/terminal-daemon-client.mjs';
import { runTerminalDaemon } from '../../desktop/terminal-daemon-server.mjs';
import {
  ensureDaemon,
  locateDaemon,
} from '../../src/platform/daemon-manager.js';
import { daemonDescriptorPath } from '../../src/platform/runtime-paths.js';
import { daemonEndpoint } from '../../src/platform/terminal-endpoint.js';

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

async function temporaryPaths(canonical = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rirei-ownership-test-'));
  roots.push(root);
  if (canonical) {
    const hash = createHash('sha256').update(root).digest('hex').slice(0, 16);
    const endpoint = daemonEndpoint({ hash, platform: process.platform });
    return {
      root,
      socketPath: endpoint.path,
      descriptorPath: daemonDescriptorPath(root),
    };
  }
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
  canonical = false,
) {
  const paths = await temporaryPaths(canonical);
  const daemon = await runTerminalDaemon({
    ...paths,
    bridgePath: path.resolve('desktop/pty_bridge.py'),
    pathValue: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
    commandFor,
    readProviderResult: async () => null,
    stopTerminateMs: 50,
    stopKillMs: 100,
    shutdownTimeoutMs: 500,
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

describe('daemon ownership', () => {
  test('requires control ownership for write and resize', async () => {
    const { descriptorPath, socketPath, root } = await startDaemon();
    const client = new TerminalDaemonClient({ descriptorPath, socketPath });
    await client.connect();
    cleanups.push(async () => client.disconnect());

    const terminal = await client.start({
      kind: 'shell',
      project: root,
      workspaceId: 'default',
    });

    // 1. Cannot write without attach
    await expect(client.write(terminal.id, 'echo hi\n')).rejects.toMatchObject({
      code: 'not_attached',
    });

    // 2. Attached as viewer but without control: write and resize must reject with not_controller
    await client.attach(terminal.id, 0);
    await expect(client.write(terminal.id, 'echo hi\n')).rejects.toMatchObject({
      code: 'not_controller',
    });
    await expect(
      client.resize(terminal.id, { cols: 100, rows: 40 }),
    ).rejects.toMatchObject({
      code: 'not_controller',
    });

    // 3. Acquire control: write and resize succeed
    await expect(client.acquireControl(terminal.id)).resolves.toEqual({
      ok: true,
      terminalId: terminal.id,
    });
    await expect(client.write(terminal.id, 'echo hi\n')).resolves.toEqual({
      ok: true,
    });
    await expect(
      client.resize(terminal.id, { cols: 100, rows: 40 }),
    ).resolves.toMatchObject({
      dimensions: { cols: 100, rows: 40 },
    });
  });

  test('rejects conflicting control acquisition with control_busy unless takeover is requested', async () => {
    const { descriptorPath, socketPath, root } = await startDaemon();
    const clientA = new TerminalDaemonClient({ descriptorPath, socketPath });
    const clientB = new TerminalDaemonClient({ descriptorPath, socketPath });
    await clientA.connect();
    await clientB.connect();
    cleanups.push(async () => {
      clientA.disconnect();
      clientB.disconnect();
    });

    const terminal = await clientA.start({
      kind: 'shell',
      project: root,
      workspaceId: 'default',
    });

    await clientA.attach(terminal.id, 0);
    await clientA.acquireControl(terminal.id);

    await clientB.attach(terminal.id, 0);

    // Client B attempts to acquire control without takeover -> control_busy
    await expect(clientB.acquireControl(terminal.id)).rejects.toMatchObject({
      code: 'control_busy',
    });

    // Setup listener for control_revoked on both clients
    const revokedEventsA: Array<{ terminalId: string; reason?: string }> = [];
    const revokedEventsB: Array<{ terminalId: string; reason?: string }> = [];
    clientA.on('control_revoked', (ev) => revokedEventsA.push(ev));
    clientB.on('control_revoked', (ev) => revokedEventsB.push(ev));

    // Client B performs takeover
    await expect(
      clientB.acquireControl(terminal.id, { takeover: true }),
    ).resolves.toEqual({
      ok: true,
      terminalId: terminal.id,
    });

    // Client A should receive control_revoked
    await new Promise((resolve) => globalThis.setTimeout(resolve, 50));
    expect(revokedEventsA).toEqual([
      expect.objectContaining({
        terminalId: terminal.id,
        reason: 'takeover',
      }),
    ]);
    // Client B should NOT receive control_revoked
    expect(revokedEventsB).toHaveLength(0);

    // Client A can no longer write
    await expect(clientA.write(terminal.id, 'data')).rejects.toMatchObject({
      code: 'not_controller',
    });

    // Client B can write
    await expect(clientB.write(terminal.id, 'data')).resolves.toEqual({
      ok: true,
    });
  });

  test('releases control on release_control, detach, and disconnect', async () => {
    const { descriptorPath, socketPath, root } = await startDaemon();
    const clientA = new TerminalDaemonClient({ descriptorPath, socketPath });
    const clientB = new TerminalDaemonClient({ descriptorPath, socketPath });
    await clientA.connect();
    await clientB.connect();
    cleanups.push(async () => {
      clientA.disconnect();
      clientB.disconnect();
    });

    const terminal = await clientA.start({
      kind: 'shell',
      project: root,
      workspaceId: 'default',
    });

    await clientA.attach(terminal.id, 0);
    await clientB.attach(terminal.id, 0);

    // 1. Explicit releaseControl
    await clientA.acquireControl(terminal.id);
    await clientA.releaseControl(terminal.id);
    // Client B can now acquire control without takeover
    await expect(clientB.acquireControl(terminal.id)).resolves.toEqual({
      ok: true,
      terminalId: terminal.id,
    });
    expect(clientB.hasControl(terminal.id)).toBe(true);

    // 2. Release on detach
    await clientB.detach(terminal.id);
    expect(clientB.hasControl(terminal.id)).toBe(false);
    // Client A can now acquire control without takeover
    await clientA.attach(terminal.id, 0);
    await expect(clientA.acquireControl(terminal.id)).resolves.toEqual({
      ok: true,
      terminalId: terminal.id,
    });

    // 3. Release on disconnect
    clientA.disconnect();
    expect(clientA.hasControl(terminal.id)).toBe(false);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 50));
    // Client B can now acquire control without takeover
    await clientB.attach(terminal.id, 0);
    await expect(clientB.acquireControl(terminal.id)).resolves.toEqual({
      ok: true,
      terminalId: terminal.id,
    });
  });

  test('releases control on terminal finalization and rejects acquisition when finalized', async () => {
    const { descriptorPath, socketPath, root } = await startDaemon();
    const client = new TerminalDaemonClient({ descriptorPath, socketPath });
    await client.connect();
    cleanups.push(async () => client.disconnect());

    const terminal = await client.start({
      kind: 'shell',
      project: root,
      workspaceId: 'default',
    });

    await client.attach(terminal.id, 0);
    await client.acquireControl(terminal.id);

    await client.stop(terminal.id);
    await waitFor(
      () => client.inspect(terminal.id),
      (t: { status?: string }) =>
        Boolean(
          t.status && ['completed', 'failed', 'cancelled'].includes(t.status),
        ),
    );
    expect(client.hasControl(terminal.id)).toBe(false);

    // Once finalized, acquiring control should reject with not_running
    await expect(client.acquireControl(terminal.id)).rejects.toMatchObject({
      code: 'not_running',
    });
  });
});

describe('safe daemon discovery', () => {
  test('preserves live daemon and rejects client connection with protocol_mismatch error', async () => {
    const { descriptorPath, socketPath } = await temporaryPaths();
    const daemonId = randomUUID();
    const reconnectToken = 'b'.repeat(43);

    // Write descriptor with old protocolVersion: 1
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

    // Create a live socket server to simulate the old daemon running
    const sockets1 = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets1.add(socket);
      socket.once('close', () => sockets1.delete(socket));
      socket.on('data', () => undefined);
    });
    cleanups.push(async () => {
      for (const s of sockets1) s.destroy();
      await new Promise((resolve) => server.close(resolve));
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    const client = new TerminalDaemonClient({ descriptorPath, socketPath });

    // Connecting should throw protocol_mismatch with instruction to restart
    await expect(client.connect()).rejects.toMatchObject({
      code: 'protocol_mismatch',
      message: expect.stringMatching(/restart the old daemon/i),
    });

    // connectOrStart should NOT spawn a new daemon over the live old daemon
    await expect(client.connectOrStart()).rejects.toMatchObject({
      code: 'protocol_mismatch',
    });

    // Descriptor file and socket MUST still exist (preserved)
    const content = await readFile(descriptorPath, 'utf8');
    expect(JSON.parse(content).protocolVersion).toBe(1);
  });

  test('locateDaemon locates a live compatible daemon without spawning or file cleanup', async () => {
    const { descriptorPath, socketPath, root } = await startDaemon(
      undefined,
      {},
      true,
    );
    const result = await locateDaemon({
      runtimeRoot: root,
    });

    expect(result.socketPath).toBe(socketPath);
    expect(result.descriptorPath).toBe(descriptorPath);
    expect(result.reused).toBe(true);
  });

  test('locateDaemon throws daemon_not_found when no daemon is active and never modifies filesystem', async () => {
    const { root, descriptorPath } = await temporaryPaths(true);

    await expect(locateDaemon({ runtimeRoot: root })).rejects.toMatchObject({
      code: 'daemon_not_found',
      message: expect.stringMatching(/no active terminal daemon/i),
    });

    // Ensure no files were spawned or created
    await expect(readFile(descriptorPath, 'utf8')).rejects.toThrow();
  });

  test('locateDaemon preserves a live endpoint whose compatible descriptor is otherwise invalid', async () => {
    const { root, socketPath, descriptorPath } = await temporaryPaths(true);
    if (process.platform !== 'win32')
      await mkdir(path.dirname(socketPath), { recursive: true });
    const descriptor = {
      schemaVersion: 99,
      protocolVersion: 2,
      daemonId: randomUUID(),
      pid: process.pid,
      socketPath,
      reconnectToken: 'c'.repeat(43),
      createdAt: new Date().toISOString(),
    };
    await writeFile(descriptorPath, JSON.stringify(descriptor));
    if (process.platform !== 'win32') await chmod(descriptorPath, 0o600);

    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    cleanups.push(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });

    await expect(locateDaemon({ runtimeRoot: root })).rejects.toMatchObject({
      code: 'protocol_mismatch',
      message: expect.stringMatching(/descriptor is invalid/i),
    });
    expect(JSON.parse(await readFile(descriptorPath, 'utf8'))).toEqual(
      descriptor,
    );
  });

  test('ensureDaemon refuses cleanup when canonical endpoint is live but descriptor is invalid', async () => {
    const { root, socketPath, descriptorPath } = await temporaryPaths(true);

    if (process.platform !== 'win32') {
      await mkdir(path.dirname(socketPath), { recursive: true });
    }

    // Create a live socket at the canonical endpoint
    const sockets2 = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets2.add(socket);
      socket.once('close', () => sockets2.delete(socket));
      socket.on('data', () => undefined);
    });
    cleanups.push(async () => {
      for (const s of sockets2) s.destroy();
      await new Promise((resolve) => server.close(resolve));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });

    // Corrupted descriptor (invalid JSON)
    await writeFile(descriptorPath, 'corrupted JSON');
    if (process.platform !== 'win32') await chmod(descriptorPath, 0o600);

    // ensureDaemon must refuse cleanup to protect the live process
    await expect(
      ensureDaemon({
        runtimeRoot: root,
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({
      code: 'protocol_mismatch',
      message: expect.stringMatching(/refusing cleanup/i),
    });

    // The descriptor file was NOT deleted
    expect(await readFile(descriptorPath, 'utf8')).toBe('corrupted JSON');
  });
});
