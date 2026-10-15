import { execFile } from 'node:child_process';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify, stripVTControlCharacters } from 'node:util';
import spawn from 'cross-spawn';
import { createTerminalHost } from '../desktop/terminal-host.mjs';

const execFileAsync = promisify(execFile);
const { values: options } = parseArgs({
  options: { tarball: { type: 'string' }, 'upgrade-from': { type: 'string' } },
});
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const temporaryRoot = await mkdtemp(
  // node-gyp's Unix makefiles cannot quote header paths containing spaces.
  path.join(
    os.tmpdir(),
    process.platform === 'win32'
      ? 'rirei packed smoke '
      : 'rirei-packed-smoke-',
  ),
);
let daemonPid = null;
let socket;
let dataRoot;
let daemonStopped = false;

async function stopSmokeDaemon() {
  if (daemonStopped) return;
  socket?.destroy();
  socket = undefined;
  if (!daemonPid && dataRoot) {
    try {
      const descriptor = JSON.parse(
        await readFile(path.join(dataRoot, 'terminal-daemon-v1.json'), 'utf8'),
      );
      if (Number.isSafeInteger(descriptor.pid) && descriptor.pid > 0)
        daemonPid = descriptor.pid;
    } catch {
      /* Setup may have exited before a daemon was started. */
    }
  }
  if (!daemonPid) return;
  const pid = daemonPid;
  if (process.platform === 'win32') {
    await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F']).catch(
      () => undefined,
    );
  } else {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* Already stopped. */
    }
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      daemonPid = null;
      daemonStopped = true;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Smoke daemon did not stop before the upgrade.');
}

async function smokeFirstTask(cli, workspace, env) {
  const terminal = await createTerminalHost(
    process.execPath,
    [cli, 'tui', workspace],
    {
      cwd: workspace,
      // Ink buffers frames until exit in CI; this child exercises a live TTY.
      env: { ...env, CI: 'false' },
      cols: 80,
      rows: 24,
    },
  );
  return new Promise((resolve, reject) => {
    let phase = 0;
    let output = '';
    const inputs = new Set();
    const send = (text) => {
      // Ink subscribes to input after its first rendered frame.
      const pending = setTimeout(() => {
        inputs.delete(pending);
        void terminal.write(text);
      }, 150);
      inputs.add(pending);
    };
    const timer = setTimeout(() => {
      void terminal.killTree();
      reject(
        new Error(
          `First-task TUI smoke timed out at step ${phase}: ${stripVTControlCharacters(output).slice(-1600).replaceAll(workspace, '<project>')}`,
        ),
      );
    }, 60_000);
    terminal.onData((data) => {
      output = (output + data).slice(-100_000);
      if (phase === 0 && output.includes('Initialize this project')) {
        phase = 1;
        output = '';
        send('\r');
      } else if (phase === 1 && output.includes('What are you working on?')) {
        phase = 2;
        output = '';
        send('Preserve a task through package upgrade');
      } else if (
        phase === 2 &&
        output.includes('Preserve a task through package upgrade')
      ) {
        phase = 3;
        output = '';
        send('\r');
      } else if (phase === 3 && output.includes('Task ready:')) {
        phase = 4;
        output = '';
        send('\r');
      } else if (phase === 4 && output.includes('CONTROL ROOM')) {
        phase = 5;
        send('q');
      }
    });
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timer);
      for (const pending of inputs) clearTimeout(pending);
      if (exitCode === 0 && phase === 5) resolve();
      else
        reject(
          new Error(
            `First-task TUI exited at step ${phase} with code ${exitCode}.`,
          ),
        );
    });
  });
}

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
          v: 2,
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
                `${JSON.stringify({ v: 2, type: 'request', id, op, body })}\n`,
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
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  let tarball = options.tarball ? path.resolve(options.tarball) : undefined;
  if (!tarball) {
    const pack = await run(
      npm,
      [
        'pack',
        '--json',
        '--ignore-scripts',
        '--pack-destination',
        temporaryRoot,
      ],
      { cwd: projectRoot },
    );
    const packed = JSON.parse(pack.stdout)[0];
    if (!packed?.filename)
      throw new Error('npm pack did not produce a tarball.');
    tarball = path.join(temporaryRoot, packed.filename);
  }
  const expectedVersion = JSON.parse(
    await readFile(path.join(projectRoot, 'package.json'), 'utf8'),
  ).version;
  const installRoot = path.join(temporaryRoot, 'install');
  const workspace = path.join(temporaryRoot, 'workspace with spaces');
  dataRoot = path.join(temporaryRoot, 'data');
  const home = path.join(temporaryRoot, 'home');
  await mkdir(installRoot);
  await mkdir(workspace);
  await mkdir(dataRoot);
  await mkdir(home);
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    RIREI_DATA_HOME: dataRoot,
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    CODEX_HOME: path.join(home, '.codex'),
    GEMINI_DATA_DIR: path.join(home, '.gemini', 'tmp'),
    ANTIGRAVITY_DATA_DIR: path.join(home, '.gemini', 'antigravity-cli'),
    OPENCODE_DATA_DIR: path.join(home, '.local', 'share', 'opencode'),
  };
  const binDir =
    process.platform === 'win32' ? installRoot : path.join(installRoot, 'bin');
  const inheritedPath = process.env.PATH ?? process.env.Path ?? '';
  for (const key of Object.keys(env))
    if (key.toLowerCase() === 'path') delete env[key];
  env.PATH = `${binDir}${path.delimiter}${inheritedPath}`;
  const install = (file) =>
    run(
      npm,
      [
        'install',
        '--global',
        '--no-audit',
        '--no-fund',
        '--prefix',
        installRoot,
        file,
      ],
      { cwd: temporaryRoot, env },
    );
  await install(
    options['upgrade-from'] ? path.resolve(options['upgrade-from']) : tarball,
  );
  const relay = path.join(
    binDir,
    process.platform === 'win32' ? 'relay.cmd' : 'relay',
  );
  const packageRoot = path.join(
    installRoot,
    ...(process.platform === 'win32' ? [] : ['lib']),
    'node_modules',
    '@taichizzz',
    'rirei',
  );
  const require = createRequire(path.join(packageRoot, 'package.json'));

  await run('git', ['init', '--quiet', workspace], { cwd: temporaryRoot, env });
  if (options['upgrade-from']) {
    // Earlier versions predate interactive onboarding.
    await run(relay, ['init'], { cwd: workspace, env });
    await run(relay, ['start', 'Preserve a task through package upgrade'], {
      cwd: workspace,
      env,
    });
  } else {
    await smokeFirstTask(
      path.join(packageRoot, 'dist', 'index.cjs'),
      workspace,
      env,
    );
  }
  const statePath = path.join(workspace, '.relay', 'state.json');
  const configPath = path.join(workspace, '.relay', 'config.json');
  const preferencesPath = path.join(dataRoot, 'token-usage-opt-in.json');
  const cachePath = path.join(dataRoot, 'token-usage-cache.json');
  await writeFile(
    preferencesPath,
    '{"optIn":false,"updatedAt":"2026-01-01T00:00:00Z"}\n',
  );
  await writeFile(cachePath, '{"smoke":"preserve existing cache"}\n');
  const preservePaths = [statePath, configPath, preferencesPath, cachePath];
  const before = await Promise.all(
    preservePaths.map((file) => readFile(file, 'utf8')),
  );
  const ensured = await run(relay, ['daemon', '--ensure'], {
    cwd: workspace,
    env,
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
  await client.request('acquire_control', { terminalId: terminal.id });
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
  await stopSmokeDaemon();

  // Install over the old package (or reinstall for the first published alpha).
  await install(tarball);
  const version = await run('relay', ['--version'], { cwd: workspace, env });
  assert.equal(version.stdout.trim(), expectedVersion);
  const doctor = JSON.parse(
    (
      await run(relay, ['doctor', '--installation', '--json'], {
        cwd: workspace,
        env,
      })
    ).stdout,
  );
  assert.equal(doctor.ok, true);
  assert.equal(doctor.version, expectedVersion);
  assert.equal(doctor.terminal.status, 'ready');
  const optIn = JSON.parse(
    (
      await run(relay, ['usage', 'tokens', '--check-opt-in', '--json'], {
        cwd: workspace,
        env,
      })
    ).stdout,
  );
  assert.equal(optIn.optedIn, false);
  assert.deepEqual(
    await Promise.all(preservePaths.map((file) => readFile(file, 'utf8'))),
    before,
  );
  if (process.platform === 'win32') {
    const ptyRoot = path.dirname(require.resolve('node-pty/package.json'));
    await access(
      path.join(ptyRoot, 'prebuilds', `win32-${process.arch}`, 'conpty.node'),
    );
    // The doctor subprocess already loaded the addon. Keep its DLL out of this
    // process so Windows can remove the package during the uninstall test.
    assert.equal(
      await access(path.join(ptyRoot, 'build', 'Release', 'pty.node')).then(
        () => true,
        () => false,
      ),
      false,
      'Windows install must use shipped prebuilds instead of requiring a compiler',
    );
  }
  await run(
    npm,
    [
      'uninstall',
      '--global',
      '--prefix',
      installRoot,
      '@taichizzz/rirei',
      '--no-audit',
      '--no-fund',
    ],
    { cwd: temporaryRoot, env },
  );
  assert.equal(
    await access(relay).then(
      () => true,
      () => false,
    ),
    false,
  );
  assert.deepEqual(
    await Promise.all(preservePaths.map((file) => readFile(file, 'utf8'))),
    before,
  );
  process.stdout.write(
    `Packed global install, daemon, PTY, ${options['upgrade-from'] ? 'upgrade' : 'reinstall'}, and uninstall smoke passed.\n`,
  );
} finally {
  await stopSmokeDaemon();
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5 });
}
