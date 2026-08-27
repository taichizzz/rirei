import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import spawn from 'cross-spawn';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const temporaryRoot = await mkdtemp(
  path.join(os.tmpdir(), 'rirei-packed-smoke-'),
);
let daemonPid = null;
let socket;

function run(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else
        reject(new Error(`${executable} exited ${code}: ${stderr || stdout}`));
    });
  });
}

function openDaemon(descriptor) {
  return new Promise((resolve, reject) => {
    const connection = net.createConnection(descriptor.socketPath);
    let buffer = '';
    let requestId = 0;
    const pending = new Map();
    let welcomed;
    const welcome = new Promise((resolveWelcome, rejectWelcome) => {
      welcomed = { resolve: resolveWelcome, reject: rejectWelcome };
    });
    const fail = (error) => {
      welcomed.reject(error);
      for (const item of pending.values()) item.reject(error);
      pending.clear();
      reject(error);
    };
    connection.once('error', fail);
    connection.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      while (buffer.includes('\n')) {
        const offset = buffer.indexOf('\n');
        const line = buffer.slice(0, offset);
        buffer = buffer.slice(offset + 1);
        if (!line) continue;
        const frame = JSON.parse(line);
        if (frame.type === 'welcome') welcomed.resolve();
        if (frame.type === 'response') {
          const item = pending.get(frame.id);
          if (!item) continue;
          pending.delete(frame.id);
          if (frame.ok) item.resolve(frame.body);
          else
            item.reject(
              new Error(frame.error?.message ?? 'Daemon request failed.'),
            );
        }
      }
    });
    connection.once('connect', async () => {
      connection.write(
        `${JSON.stringify({
          v: 1,
          type: 'hello',
          token: descriptor.reconnectToken,
          clientId: randomUUID(),
          pid: process.pid,
        })}\n`,
      );
      try {
        await welcome;
        resolve({
          socket: connection,
          request(op, body = {}) {
            const id = String(++requestId);
            return new Promise((resolveRequest, rejectRequest) => {
              pending.set(id, {
                resolve: resolveRequest,
                reject: rejectRequest,
              });
              connection.write(
                `${JSON.stringify({ v: 1, type: 'request', id, op, body })}\n`,
              );
            });
          },
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

try {
  const pack = await run(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['pack', '--json', '--ignore-scripts', '--pack-destination', temporaryRoot],
    { cwd: projectRoot },
  );
  const packed = JSON.parse(pack.stdout)[0];
  if (!packed?.filename) throw new Error('npm pack did not produce a tarball.');
  const installRoot = path.join(temporaryRoot, 'install');
  const workspace = path.join(temporaryRoot, 'workspace');
  const dataRoot = path.join(temporaryRoot, 'data');
  await mkdir(installRoot);
  await mkdir(workspace);
  await run(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    [
      'install',
      '--no-audit',
      '--no-fund',
      '--prefix',
      installRoot,
      path.join(temporaryRoot, packed.filename),
    ],
    { cwd: temporaryRoot },
  );
  const relay = path.join(
    installRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'relay.cmd' : 'relay',
  );
  const ensured = await run(relay, ['daemon', '--ensure'], {
    cwd: workspace,
    env: { ...process.env, RIREI_DATA_HOME: dataRoot },
  });
  const daemonInfo = JSON.parse(ensured.stdout.trim());
  const descriptor = JSON.parse(
    await readFile(daemonInfo.descriptorPath, 'utf8'),
  );
  daemonPid = descriptor.pid;
  const client = await openDaemon(descriptor);
  socket = client.socket;
  const terminal = await client.request('start', {
    kind: 'shell',
    project: workspace,
    workspaceId: 'default',
    size: { cols: 80, rows: 24 },
  });
  let cursor = 0;
  let output = '';
  await client.request('attach', { terminalId: terminal.id, cursor });
  const command =
    process.platform === 'win32'
      ? 'echo RIREI_PACKED_PTY_OK\r\nexit\r\n'
      : "printf 'RIREI_PACKED_PTY_OK\\n'; exit\n";
  await client.request('write', {
    terminalId: terminal.id,
    data: Buffer.from(command).toString('base64'),
  });
  const deadline = Date.now() + 10_000;
  while (!output.includes('RIREI_PACKED_PTY_OK') && Date.now() < deadline) {
    const slice = await client.request('attach', {
      terminalId: terminal.id,
      cursor,
    });
    output += Buffer.from(slice.data, 'base64').toString('utf8');
    cursor = slice.endCursor;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!output.includes('RIREI_PACKED_PTY_OK'))
    throw new Error('Packed daemon PTY did not return the smoke marker.');
  process.stdout.write('Packed install daemon and PTY smoke passed.\n');
} finally {
  socket?.destroy();
  if (daemonPid) {
    if (process.platform === 'win32')
      await execFileAsync('taskkill', [
        '/PID',
        String(daemonPid),
        '/T',
        '/F',
      ]).catch(() => undefined);
    else {
      try {
        process.kill(daemonPid, 'SIGTERM');
      } catch {
        // Daemon already stopped.
      }
    }
  }
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5 });
}
