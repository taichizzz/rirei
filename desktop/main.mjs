import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const agents = new Set(['claude', 'codex', 'gemini', 'antigravity']);
const terminalSessions = new Map();
const commands = new Set([
  'init',
  'start',
  'status',
  'doctor',
  'checkpoint',
  'handoff',
  'finish',
]);

function cliPath() {
  const embedded = path.join(process.resourcesPath, 'cli', 'index.cjs');
  return existsSync(embedded)
    ? embedded
    : path.join(here, '..', 'dist', 'index.cjs');
}

function nodePath() {
  for (const candidate of ['/usr/local/bin/node', '/opt/homebrew/bin/node']) {
    if (existsSync(candidate)) return candidate;
  }
  return 'node';
}

function validProject(project) {
  return (
    typeof project === 'string' &&
    path.isAbsolute(project) &&
    project.length < 4096
  );
}

function validSelection(value, maxLength = 120) {
  return (
    value === undefined ||
    (typeof value === 'string' &&
      value.length > 0 &&
      value.length <= maxLength &&
      !value.startsWith('-') &&
      !value.includes('\0'))
  );
}

function runCli(project, command, args = []) {
  return new Promise((resolve) => {
    const child = spawn(nodePath(), [cliPath(), command, ...args], {
      cwd: project,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => (stdout += data));
    child.stderr.on('data', (data) => (stderr += data));
    child.once('error', (error) =>
      resolve({ ok: false, output: error.message }),
    );
    child.once('close', (code) =>
      resolve({ ok: code === 0, output: `${stdout}${stderr}`.trim() }),
    );
  });
}

function terminalSize(size) {
  const clamp = (value, fallback) =>
    Number.isInteger(value) && value >= 1 && value <= 10000 ? value : fallback;
  return {
    cols: clamp(size?.cols, 80),
    rows: clamp(size?.rows, 24),
  };
}

function startTerminal(event, project, command, agent, size, selection) {
  if (!existsSync(path.join(project, '.relay', 'config.json'))) {
    return {
      ok: false,
      output: 'Initialize this project before running an agent.',
    };
  }
  if (!existsSync(path.join(project, '.relay', 'state.json'))) {
    return {
      ok: false,
      output:
        'Start a Relay task before running an agent. Enter a task description and click Start task.',
    };
  }
  const key = event.sender.id;
  if (terminalSessions.has(key))
    return { ok: false, output: 'A terminal session is already running.' };
  const pathValue = [
    path.join(app.getPath('home'), '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
  ].join(':');
  const { cols, rows } = terminalSize(size);
  const child = spawn(
    '/usr/bin/python3',
    [
      path.join(here, 'pty_bridge.py'),
      nodePath(),
      cliPath(),
      command,
      agent,
      ...(selection.model ? ['--model', selection.model] : []),
      ...(selection.effort ? ['--effort', selection.effort] : []),
    ],
    {
      cwd: project,
      env: {
        ...process.env,
        PATH: pathValue,
        RELAY_COLS: String(cols),
        RELAY_ROWS: String(rows),
        TERM: process.env.TERM ?? 'xterm-256color',
      },
      // fd 3 is a control channel the renderer uses to send terminal resizes.
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    },
  );
  terminalSessions.set(key, child);
  const send = (channel, payload) => {
    if (!event.sender.isDestroyed()) event.sender.send(channel, payload);
  };
  child.stdout.on('data', (data) =>
    send('relay:terminal-data', data.toString()),
  );
  child.stderr.on('data', (data) =>
    send('relay:terminal-data', data.toString()),
  );
  child.once('error', (error) => {
    terminalSessions.delete(key);
    send('relay:terminal-exit', { code: null, error: error.message });
  });
  child.once('close', (code) => {
    terminalSessions.delete(key);
    send('relay:terminal-exit', { code });
  });
  return { ok: true, output: `Started ${agent} in the Relay terminal.` };
}

function registerIpc() {
  ipcMain.handle('relay:select-project', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('relay:command', (_event, request) => {
    if (
      !request ||
      !validProject(request.project) ||
      !commands.has(request.command)
    )
      return { ok: false, output: 'Invalid desktop command.' };
    const args = [];
    if (request.command === 'start') {
      if (typeof request.value !== 'string' || !request.value.trim())
        return { ok: false, output: 'Enter a task first.' };
      args.push(request.value.trim());
      if (request.allowDirty === true) args.push('--allow-dirty');
    }
    if (
      request.command === 'checkpoint' &&
      typeof request.value === 'string' &&
      request.value.trim()
    )
      args.push('--message', request.value.trim());
    return runCli(request.project, request.command, args);
  });
  ipcMain.handle('relay:usage', async (_event, request) => {
    if (!request || !validProject(request.project))
      return { ok: false, output: 'Invalid project.' };
    const result = await runCli(request.project, 'usage', ['--json']);
    if (!result.ok) return result;
    try {
      return { ok: true, data: JSON.parse(result.output) };
    } catch {
      return { ok: false, output: result.output || 'Could not read usage.' };
    }
  });
  ipcMain.handle('relay:dashboard', async (_event, request) => {
    if (!request || !validProject(request.project))
      return { ok: false, output: 'Invalid project.' };
    const result = await runCli(request.project, 'status', ['--json']);
    if (!result.ok) return result;
    try {
      return { ok: true, data: JSON.parse(result.output) };
    } catch {
      return { ok: false, output: 'Could not read structured task status.' };
    }
  });
  ipcMain.handle('relay:agent-catalog', async (_event, request) => {
    if (!request || !validProject(request.project))
      return { ok: false, output: 'Invalid project.' };
    const result = await runCli(request.project, 'agents', ['--json']);
    if (!result.ok) return result;
    try {
      return { ok: true, data: JSON.parse(result.output) };
    } catch {
      return { ok: false, output: 'Could not read agent capabilities.' };
    }
  });
  ipcMain.handle('relay:interactive', (event, request) => {
    if (
      !request ||
      !validProject(request.project) ||
      !['run', 'switch'].includes(request.command) ||
      !agents.has(request.agent) ||
      !validSelection(request.model) ||
      !validSelection(request.effort, 20)
    )
      return { ok: false, output: 'Invalid interactive command.' };
    return startTerminal(
      event,
      request.project,
      request.command,
      request.agent,
      request.size,
      { model: request.model, effort: request.effort },
    );
  });
  ipcMain.on('relay:terminal-input', (event, data) => {
    const child = terminalSessions.get(event.sender.id);
    if (child?.stdin.writable && typeof data === 'string')
      child.stdin.write(data);
  });
  ipcMain.on('relay:terminal-resize', (event, size) => {
    const child = terminalSessions.get(event.sender.id);
    const control = child?.stdio[3];
    if (control?.writable) {
      const { cols, rows } = terminalSize(size);
      control.write(`${JSON.stringify({ cols, rows })}\n`);
    }
  });
  ipcMain.handle('relay:terminal-stop', (event) => {
    const child = terminalSessions.get(event.sender.id);
    if (!child) return { ok: false, output: 'No terminal session is running.' };
    child.stdin.write('\u0003');
    return { ok: true, output: 'Interrupt sent.' };
  });
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 720,
    minHeight: 560,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.loadFile(path.join(here, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  app.on(
    'activate',
    () => BrowserWindow.getAllWindows().length === 0 && createWindow(),
  );
});
app.on('window-all-closed', () => app.quit());
