import { execFile } from 'node:child_process';
import { chmod, lstat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import nodePtyLoader from './node-pty-loader.cjs';

const execFileAsync = promisify(execFile);
const PARENT_GUARD_READY = '\x1b]777;rirei-parent-guard-ready\x07';
const PARENT_GUARD_CODE = String.raw`
const { execFile, execFileSync, spawn } = require('node:child_process');
const command = JSON.parse(process.env.RIREI_GUARD_COMMAND);
const parentPid = Number(process.env.RIREI_GUARD_PARENT_PID);
let child = null;
let stopping = false;
let forced = false;
function stop(force) {
  if (stopping && !force) return;
  if (force && forced) return;
  if (force) forced = true;
  stopping = true;
  if (process.platform === 'win32') {
    if (!child) return process.exit(force ? 1 : 0);
    const args = ['/PID', String(child.pid), '/T'];
    if (force) args.push('/F');
    execFile('taskkill', args, { windowsHide: true }, () =>
      process.exit(force ? 1 : 0),
    );
    setTimeout(() => process.exit(1), 5000).unref();
    return;
  }
  if (!force) {
    if (!child) return process.exit(0);
    try { child.kill('SIGTERM'); } catch {}
    return;
  }
  let stdout = '';
  try { stdout = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }); } catch {}
    const children = new Map();
    for (const row of stdout.split('\n')) {
      const [pidText, parentText] = row.trim().split(/\s+/);
      const pid = Number(pidText);
      const parent = Number(parentText);
      if (!Number.isInteger(pid) || !Number.isInteger(parent)) continue;
      const values = children.get(parent) || [];
      values.push(pid);
      children.set(parent, values);
    }
    const targets = [];
    const pending = child ? [child.pid] : [];
    while (pending.length) {
      const pid = pending.pop();
      targets.push(pid);
      pending.push(...(children.get(pid) || []));
    }
    for (const pid of targets.reverse()) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  setTimeout(() => process.exit(1), 1000).unref();
}
process.on('SIGTERM', () => stop(false));
process.on('SIGHUP', () => stop(true));
const monitor = setInterval(() => {
  try { process.kill(parentPid, 0); }
  catch { stop(true); }
}, 200);
try { process.kill(parentPid, 0); } catch { stop(true); }
process.stdout.write('\x1b]777;rirei-parent-guard-ready\x07');
const childEnv = { ...process.env };
delete childEnv.RIREI_GUARD_COMMAND;
delete childEnv.RIREI_GUARD_PARENT_PID;
child = spawn(command[0], command.slice(1), { cwd: process.cwd(), env: childEnv, stdio: 'inherit' });
child.once('error', () => { clearInterval(monitor); process.exit(1); });
child.once('close', (code, signal) => {
  clearInterval(monitor);
  process.exit(typeof code === 'number' ? code : signal ? 128 : 1);
});
`;

let ptyModule = null;
let ptyPackageRoot = null;
function getPty() {
  if (!ptyModule) {
    ptyPackageRoot = nodePtyLoader.packageRoot();
    ptyModule = nodePtyLoader.load();
  }
  return ptyModule;
}

let helperChecked = false;
async function ensureSpawnHelperExecutable() {
  if (helperChecked || process.platform === 'win32') return;
  helperChecked = true;
  getPty();
  const candidates = [
    path.join(
      ptyPackageRoot,
      'prebuilds',
      `${process.platform}-${process.arch}`,
      'spawn-helper',
    ),
    path.join(ptyPackageRoot, 'build', 'Release', 'spawn-helper'),
  ];
  for (const helper of candidates) {
    try {
      const stats = await lstat(helper);
      if (stats.isFile() && (stats.mode & 0o111) === 0) {
        await chmod(helper, 0o755);
      }
    } catch {
      // Helper not present at this path
    }
  }
}

async function unixDescendants(rootPid) {
  try {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid='], {
      encoding: 'utf8',
      timeout: 3000,
    });
    const children = new Map();
    for (const row of stdout.split('\n')) {
      const [pidText, parentText] = row.trim().split(/\s+/);
      const pid = Number.parseInt(pidText, 10);
      const parent = Number.parseInt(parentText, 10);
      if (!Number.isInteger(pid) || !Number.isInteger(parent)) continue;
      const values = children.get(parent) ?? [];
      values.push(pid);
      children.set(parent, values);
    }
    const descendants = [];
    const pending = [...(children.get(rootPid) ?? [])];
    while (pending.length > 0) {
      const pid = pending.pop();
      descendants.push(pid);
      pending.push(...(children.get(pid) ?? []));
    }
    return descendants.reverse();
  } catch {
    return [];
  }
}

async function signalProcessTree(pid, signal, force = false) {
  if (process.platform === 'win32') {
    const args = ['/PID', String(pid), '/T'];
    if (force) args.push('/F');
    try {
      await execFileAsync('taskkill', args, {
        timeout: 5000,
        windowsHide: true,
      });
    } catch {
      // The tree is already gone or inaccessible.
    }
    return;
  }

  try {
    process.kill(-pid, signal);
    return;
  } catch {
    // Fall back to explicit descendant traversal if no process group exists.
  }
  for (const target of [...(await unixDescendants(pid)), pid]) {
    try {
      process.kill(target, signal);
    } catch {
      // Process already terminated.
    }
  }
}

export class NodePtyTerminalHost {
  constructor(executable, args, options = {}) {
    const pty = getPty();
    const cols = Math.max(1, options.cols ?? 80);
    const rows = Math.max(1, options.rows ?? 24);

    this.dataListeners = new Set();
    this.exitListeners = new Set();
    this.disposed = false;
    this.guardBuffer = '';
    this.ready = options.parentGuardNodePath
      ? new Promise((resolve, reject) => {
          this.resolveReady = resolve;
          this.rejectReady = reject;
        })
      : Promise.resolve();

    const guarded = options.parentGuardNodePath
      ? {
          executable: options.parentGuardNodePath,
          args: ['-e', PARENT_GUARD_CODE],
          env: {
            ...(options.env ?? process.env),
            RIREI_GUARD_COMMAND: JSON.stringify([executable, ...args]),
            RIREI_GUARD_PARENT_PID: String(process.pid),
          },
        }
      : { executable, args, env: options.env ?? process.env };

    this.ptyProcess = pty.spawn(guarded.executable, guarded.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: options.cwd,
      env: guarded.env,
      useConpty: options.useConpty ?? process.platform === 'win32',
    });

    this.ptyProcess.onData((chunk) => {
      if (this.disposed) return;
      if (this.resolveReady) {
        this.guardBuffer += chunk;
        const markerOffset = this.guardBuffer.indexOf(PARENT_GUARD_READY);
        if (markerOffset < 0) {
          if (this.guardBuffer.length <= PARENT_GUARD_READY.length) return;
          chunk = this.guardBuffer.slice(
            0,
            this.guardBuffer.length - PARENT_GUARD_READY.length,
          );
          this.guardBuffer = this.guardBuffer.slice(
            this.guardBuffer.length - PARENT_GUARD_READY.length,
          );
        } else {
          chunk = `${this.guardBuffer.slice(0, markerOffset)}${this.guardBuffer.slice(markerOffset + PARENT_GUARD_READY.length)}`;
          this.guardBuffer = '';
          this.resolveReady();
          this.resolveReady = null;
          this.rejectReady = null;
        }
      }
      if (!chunk) return;
      const buffer = Buffer.from(chunk, 'utf8');
      for (const listener of this.dataListeners) {
        try {
          listener(buffer);
        } catch {
          // Ignore listener error
        }
      }
    });

    this.ptyProcess.onExit((event) => {
      if (this.disposed) return;
      this.disposed = true;
      this.rejectReady?.(
        new Error('Terminal parent guard exited before ready.'),
      );
      this.resolveReady = null;
      this.rejectReady = null;
      const exitResult = {
        exitCode: Number.isInteger(event.exitCode) ? event.exitCode : null,
        signal: event.signal ? String(event.signal) : null,
        error: null,
      };
      for (const listener of this.exitListeners) {
        try {
          listener(exitResult);
        } catch {
          // Ignore listener error
        }
      }
    });
  }

  get pid() {
    return this.ptyProcess.pid;
  }

  async write(data) {
    if (this.disposed) throw new Error('Terminal process has exited.');
    const text =
      typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
    this.ptyProcess.write(text);
  }

  resize(cols, rows) {
    if (this.disposed) return;
    try {
      this.ptyProcess.resize(Math.max(1, cols), Math.max(1, rows));
    } catch {
      // Ignore resize on dead terminal
    }
  }

  async interrupt(intent) {
    if (this.disposed) return;
    if (process.platform === 'win32') {
      if (intent === 'user_interrupt') {
        this.ptyProcess.write('\x03');
      } else {
        await signalProcessTree(this.ptyProcess.pid, 'SIGTERM', false);
      }
      return;
    }
    await signalProcessTree(
      this.ptyProcess.pid,
      intent === 'user_stop' ? 'SIGTERM' : 'SIGINT',
    );
  }

  async terminate() {
    if (this.disposed) return;
    await signalProcessTree(this.ptyProcess.pid, 'SIGTERM', false);
  }

  async killTree() {
    if (this.disposed) return;
    await signalProcessTree(this.ptyProcess.pid, 'SIGKILL', true);
  }

  onData(listener) {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onExit(listener) {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }
}

export async function createTerminalHost(executable, args, options = {}) {
  await ensureSpawnHelperExecutable();
  const host = new NodePtyTerminalHost(executable, args, options);
  let timer;
  try {
    await Promise.race([
      host.ready,
      new Promise((_, reject) => {
        timer = globalThis.setTimeout(
          () =>
            reject(new Error('Terminal parent guard did not become ready.')),
          5000,
        );
      }),
    ]);
    return host;
  } catch (error) {
    await host.killTree();
    throw error;
  } finally {
    globalThis.clearTimeout(timer);
  }
}
