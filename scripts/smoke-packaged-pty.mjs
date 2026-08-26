import { readdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import spawn from 'cross-spawn';

if (process.platform !== 'darwin') {
  process.stdout.write('Packaged PTY smoke is macOS-only; skipped.\n');
  process.exit(0);
}

async function findApp(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory() && entry.name === 'Rirei.app') return candidate;
    if (entry.isDirectory()) {
      const found = await findApp(candidate).catch(() => null);
      if (found) return found;
    }
  }
  return null;
}

const app = await findApp(path.resolve('dist'));
if (!app) throw new Error('No packaged Rirei.app found under dist/.');
const executable = path.join(app, 'Contents', 'MacOS', 'Rirei');
const hostUrl = pathToFileURL(
  path.join(
    app,
    'Contents',
    'Resources',
    'app.asar.unpacked',
    'desktop',
    'terminal-host.mjs',
  ),
).href;
const cwd = await mkdtemp(path.join(os.tmpdir(), 'rirei-packaged-pty-'));
const code = `
const module = await import(process.env.RIREI_TERMINAL_HOST_URL);
const host = await module.createTerminalHost('/bin/sh', ['-c', 'sleep 0.1; printf RIREI_PACKAGED_PTY_OK'], { cwd: process.cwd(), env: process.env });
let output = '';
host.onData((data) => { output += Buffer.from(data).toString('utf8'); });
const result = await new Promise((resolve) => host.onExit(resolve));
if (result.exitCode !== 0 || !output.includes('RIREI_PACKAGED_PTY_OK')) process.exit(1);
process.stdout.write('RIREI_PACKAGED_PTY_OK\\n');
`;

try {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, ['--input-type=module', '-e', code], {
      cwd,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        RIREI_TERMINAL_HOST_URL: hostUrl,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Packaged PTY smoke timed out.'));
    }, 15_000);
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (exitCode) => {
      clearTimeout(timer);
      if (exitCode === 0 && stdout.includes('RIREI_PACKAGED_PTY_OK')) resolve();
      else
        reject(
          new Error(stderr || stdout || `Packaged app exited ${exitCode}.`),
        );
    });
  });
  process.stdout.write('Packaged Electron node-pty smoke passed.\n');
} finally {
  await rm(cwd, { recursive: true, force: true });
}
