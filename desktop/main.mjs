import { app, BrowserWindow, dialog, ipcMain, Notification } from 'electron';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readValidatedActivitySnapshot } from './activity-snapshot.mjs';
import {
  DeepLinkIntentQueue,
  parseTerminalDeepLink,
  terminalDeepLinksFromArgv,
  terminalOwnerWebContentsId,
} from './deep-links.mjs';
import { createUsageAlertPolicy } from './usage-alert-policy.mjs';
import { TerminalManager } from './terminal-manager.mjs';
import { terminalControlFrame } from './terminal-control.mjs';
import { sanitizeWorkspaceList } from './workspace-projection.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const agents = new Set(['claude', 'codex', 'gemini', 'antigravity']);
const terminalManager = new TerminalManager(4);
const deepLinkIntents = new DeepLinkIntentQueue();
const readyRenderers = new Set();
let appReady = false;

const usageSubscriptions = new Map();
const usageAlertPolicy = createUsageAlertPolicy();
const liveNotifications = new Set();
const USAGE_POLL_INTERVAL_MS = 60_000;
const providerNames = Object.freeze({
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  antigravity: 'Antigravity',
});
const usageWindowNames = Object.freeze({
  fiveHour: '5-hour usage',
  week: 'Weekly usage',
});
const commands = new Set([
  'init',
  'start',
  'status',
  'doctor',
  'checkpoint',
  'handoff',
  'finish',
  'recover',
]);

function cliPath() {
  const embedded = path.join(process.resourcesPath, 'cli', 'index.cjs');
  return existsSync(embedded)
    ? embedded
    : path.join(here, '..', 'dist', 'index.cjs');
}

function ptyBridgePath() {
  const local = path.join(here, 'pty_bridge.py');
  if (!app.isPackaged || (!local.includes('.asar') && existsSync(local)))
    return local;
  const unpacked = path.join(
    process.resourcesPath,
    'app.asar.unpacked',
    'desktop',
    'pty_bridge.py',
  );
  if (existsSync(unpacked)) return unpacked;
  throw new Error('The packaged PTY bridge is missing.');
}

function nodePath() {
  for (const candidate of ['/usr/local/bin/node', '/opt/homebrew/bin/node']) {
    if (existsSync(candidate)) return candidate;
  }
  return 'node';
}

function loginShellPath() {
  const configured = process.env.SHELL;
  if (configured && path.isAbsolute(configured) && existsSync(configured))
    return configured;
  return '/bin/zsh';
}

function validProject(project) {
  return (
    typeof project === 'string' &&
    path.isAbsolute(project) &&
    project.length < 4096
  );
}

function validProjectDirectory(project) {
  if (!validProject(project)) return false;
  try {
    return statSync(project).isDirectory();
  } catch {
    return false;
  }
}

function repositoryRoot(project) {
  if (!validProjectDirectory(project)) return null;
  const result = spawnSync(
    'git',
    ['-C', project, 'rev-parse', '--show-toplevel'],
    { encoding: 'utf8', timeout: 5000 },
  );
  if (result.status !== 0) return null;
  const root = result.stdout.trim();
  return path.isAbsolute(root) && validProjectDirectory(root) ? root : null;
}

function currentBranchLabel(project) {
  const result = spawnSync('git', ['-C', project, 'branch', '--show-current'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  return result.status === 0 && result.stdout.trim()
    ? result.stdout.trim()
    : 'detached HEAD';
}

function globalActivityFile() {
  const override = process.env.RIREI_DATA_HOME?.trim();
  if (override)
    return path.join(
      path.isAbsolute(override)
        ? path.resolve(override)
        : path.resolve(app.getPath('home'), override),
      'activity.json',
    );
  if (process.platform === 'darwin')
    return path.join(
      app.getPath('home'),
      'Library',
      'Application Support',
      'Rirei',
      'activity.json',
    );
  const xdg = process.env.XDG_DATA_HOME?.trim();
  return path.join(
    xdg
      ? path.join(path.resolve(xdg), 'rirei')
      : path.join(app.getPath('home'), '.local', 'share', 'rirei'),
    'activity.json',
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
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.stdout.on('data', (data) => (stdout += data));
    child.stderr.on('data', (data) => (stderr += data));
    child.once('error', (error) =>
      finish({
        ok: false,
        stdout,
        stderr: error.message,
        output: error.message,
      }),
    );
    child.once('close', (code) =>
      finish({
        ok: code === 0,
        stdout,
        stderr,
        output: `${stdout}${stderr}`.trim(),
      }),
    );
  });
}

function fixedNotification(kind, details = {}) {
  const provider = providerNames[details.provider];
  if (kind === 'task-completed') return { title: 'Task completed' };
  if (kind === 'checkpoint-created') return { title: 'Checkpoint created' };
  if (kind === 'agent-success' && provider)
    return { title: `${provider} session finished` };
  if (kind === 'agent-failure' && provider)
    return { title: `${provider} session ended with an error` };
  const windowName = usageWindowNames[details.window];
  if (
    kind === 'usage-low' &&
    provider &&
    windowName &&
    [20, 5].includes(details.threshold)
  )
    return {
      title: `${provider} usage is low`,
      body: `${windowName} has ${details.threshold}% or less remaining.`,
    };
  return null;
}

function showNativeNotification(window, kind, details, routine = false) {
  if (
    !window ||
    window.isDestroyed() ||
    (routine && window.isFocused()) ||
    !Notification.isSupported()
  )
    return;
  const template = fixedNotification(kind, details);
  if (!template) return;
  try {
    const notification = new Notification(template);
    liveNotifications.add(notification);
    notification.once('close', () => liveNotifications.delete(notification));
    notification.on('click', () => {
      if (window.isDestroyed()) return;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    });
    notification.show();
  } catch {
    // Desktop notifications are best-effort and must not affect the session.
  }
}

function safeIso(value) {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function safePercentage(value) {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100
    ? value
    : undefined;
}

function sanitizeUsageWindow(value) {
  if (!value || typeof value !== 'object') return undefined;
  const remainingPercentage = safePercentage(value.remainingPercentage);
  const usedPercentage = safePercentage(value.usedPercentage);
  const resetsAt = safeIso(value.resetsAt);
  if (
    remainingPercentage === undefined ||
    usedPercentage === undefined ||
    resetsAt === undefined ||
    !['available', 'stale'].includes(value.status)
  )
    return undefined;
  return {
    usedPercentage,
    remainingPercentage,
    resetsAt,
    status: value.status,
  };
}

function sanitizeUsage(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.plans))
    return null;
  const taskStatus = ['active', 'blocked', 'completed', 'cancelled'].includes(
    value.task?.status,
  )
    ? value.task.status
    : 'active';
  const taskTitle =
    typeof value.task?.title === 'string' && value.task.title.length <= 500
      ? value.task.title
      : 'Current task';
  const plans = [];
  for (const plan of value.plans) {
    if (
      !plan ||
      typeof plan !== 'object' ||
      !Object.hasOwn(providerNames, plan.id) ||
      !['available', 'stale', 'unknown'].includes(plan.status)
    )
      continue;
    const capturedAt = safeIso(plan.capturedAt);
    if (capturedAt === undefined) continue;
    const available = plan.status === 'available';
    const sanitized = {
      id: plan.id,
      displayName: providerNames[plan.id],
      status: plan.status,
      capturedAt,
      source: available ? 'Provider usage' : 'Unavailable',
      detail: available
        ? 'Current provider rate-limit usage.'
        : 'No current provider usage is available.',
    };
    const fiveHour = sanitizeUsageWindow(plan.fiveHour);
    const week = sanitizeUsageWindow(plan.week);
    if (fiveHour) sanitized.fiveHour = fiveHour;
    if (week) sanitized.week = week;
    plans.push(sanitized);
  }
  return { task: { title: taskTitle, status: taskStatus }, plans };
}

function clearUsageSubscription(senderId) {
  const subscription = usageSubscriptions.get(senderId);
  if (!subscription) return;
  if (subscription.timer) globalThis.clearTimeout(subscription.timer);
  usageSubscriptions.delete(senderId);
}

async function pollUsage(subscription) {
  if (
    usageSubscriptions.get(subscription.senderId) !== subscription ||
    subscription.sender.isDestroyed() ||
    subscription.window.isDestroyed() ||
    subscription.polling
  )
    return;
  subscription.polling = true;
  try {
    const result = await runCli(subscription.project, 'usage', [
      '--plans-only',
      '--json',
    ]);
    if (
      !result.ok ||
      usageSubscriptions.get(subscription.senderId) !== subscription ||
      subscription.sender.isDestroyed() ||
      subscription.window.isDestroyed()
    )
      return;
    let usage;
    try {
      usage = sanitizeUsage(JSON.parse(result.stdout));
    } catch {
      return;
    }
    if (!usage) return;
    subscription.sender.send('relay:usage-update', usage);
    for (const alert of usageAlertPolicy.evaluate(subscription.project, usage))
      showNativeNotification(subscription.window, 'usage-low', alert, false);
  } finally {
    subscription.polling = false;
    if (usageSubscriptions.get(subscription.senderId) === subscription) {
      subscription.timer = globalThis.setTimeout(
        () => pollUsage(subscription),
        USAGE_POLL_INTERVAL_MS,
      );
    }
  }
}

function setActiveProject(event, project) {
  clearUsageSubscription(event.sender.id);
  if (!validProjectDirectory(project)) return;
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || window.isDestroyed()) return;
  const subscription = {
    senderId: event.sender.id,
    sender: event.sender,
    window,
    project,
    timer: null,
    polling: false,
  };
  usageSubscriptions.set(event.sender.id, subscription);
  void pollUsage(subscription);
}

function terminalSize(size) {
  const clamp = (value, fallback) =>
    Number.isInteger(value) && value >= 1 && value <= 10000 ? value : fallback;
  return {
    cols: clamp(size?.cols, 80),
    rows: clamp(size?.rows, 24),
  };
}

function safeStreamWrite(stream, data) {
  if (!stream?.writable || stream.destroyed) return false;
  try {
    stream.write(data, () => undefined);
    return true;
  } catch {
    return false;
  }
}

function terminalForProject(project) {
  for (const t of terminalManager.terminals.values()) {
    if (
      t.project === project &&
      (t.status === 'starting' ||
        t.status === 'running' ||
        t.status === 'waiting' ||
        t.status === 'stopping')
    )
      return t;
  }
  return null;
}

function ownedTerminal(event, terminalId) {
  if (typeof terminalId !== 'string') return null;
  return terminalManager.get(terminalId, event.sender.id);
}

function getActiveTerminalClaims(project) {
  const leases = new Set();
  for (const t of terminalManager.terminals.values()) {
    if (
      t.project === project &&
      ['starting', 'running', 'waiting', 'stopping'].includes(t.status)
    ) {
      leases.add(t.workspaceId || 'default');
    }
  }
  return leases;
}

async function readWorkspaceProjection(project) {
  const [workspaceResult, statusResult] = await Promise.all([
    runCli(project, 'workspace', ['list', '--json']),
    runCli(project, 'status', ['--json']),
  ]);
  if (!workspaceResult.ok) return workspaceResult;
  if (!statusResult.ok) return statusResult;
  try {
    return {
      ok: true,
      data: sanitizeWorkspaceList(
        JSON.parse(workspaceResult.stdout),
        JSON.parse(statusResult.stdout),
        getActiveTerminalClaims(project),
      ),
    };
  } catch {
    return { ok: false, output: 'Could not parse workspace state.' };
  }
}

function escalateStop(child, managed) {
  if (!child || managed.finalized || managed._stopTimers?.length > 0) return;
  const control = child.stdio[3];

  // 1. Interrupt
  safeStreamWrite(control, terminalControlFrame('interrupt'));

  // 2. Terminate after 2s
  const terminateTimer = globalThis.setTimeout(() => {
    if (!managed.finalized)
      safeStreamWrite(child.stdio[3], terminalControlFrame('terminate'));
  }, 2000);

  // 3. Kill after 4s
  const killTimer = globalThis.setTimeout(() => {
    if (!managed.finalized)
      safeStreamWrite(child.stdio[3], terminalControlFrame('kill'));
  }, 4000);

  managed._stopTimers = [terminateTimer, killTimer];
}

function flushTerminalOutput(managed) {
  const batch = terminalManager.takePendingOutput(managed.id);
  if (batch && managed._send) {
    managed._send('relay:terminal-data', {
      terminalId: managed.id,
      data: batch.data,
      sequence: batch.sequence,
    });
    return;
  }
  if (
    managed.pendingExit &&
    !managed.awaitingOutputAck &&
    managed.pendingOutputSize === 0
  ) {
    managed._send?.('relay:terminal-exit', managed.pendingExit);
    managed.pendingExit = null;
  }
}

function terminalPreflight(project) {
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
  return null;
}

function startTerminal(event, project, command, agent, size, selection) {
  const shellSession = command === 'shell';
  if (!shellSession) {
    const preflight = terminalPreflight(project);
    if (preflight) return preflight;
  }
  const workspaceId = selection.workspace || 'default';

  if (workspaceId !== 'default' && command !== 'run') {
    return {
      ok: false,
      output: `The '${command}' command does not support workspace launches.`,
    };
  }

  let managed;
  try {
    managed = terminalManager.reserveTerminal(
      event.sender.id,
      workspaceId,
      selection.branchLabel ||
        (workspaceId === 'default' ? 'main' : workspaceId),
      project,
      agent,
    );
  } catch (err) {
    return { ok: false, output: err.message };
  }

  const terminalId = managed.id;

  const pathValue = [
    path.join(app.getPath('home'), '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
  ].join(':');
  const { cols, rows } = terminalSize(size);
  const bridgeCommand = shellSession
    ? [loginShellPath(), '-l']
    : [
        nodePath(),
        cliPath(),
        command,
        agent,
        ...(command === 'resume'
          ? selection.resumeTargetKind === 'latest'
            ? ['--latest']
            : selection.resumeTargetKind === 'id'
              ? ['--id', selection.resumeTargetValue]
              : ['--picker']
          : []),
        ...(command === 'resume' && selection.fork ? ['--fork'] : []),
        ...(selection.model ? ['--model', selection.model] : []),
        ...(selection.effort ? ['--effort', selection.effort] : []),
        ...(selection.workspace ? ['--workspace', selection.workspace] : []),
        '--operation-id',
        terminalId,
        '--terminal-id',
        terminalId,
      ];

  let child;
  try {
    child = spawn('/usr/bin/python3', [ptyBridgePath(), ...bridgeCommand], {
      cwd: project,
      env: {
        ...process.env,
        PATH: pathValue,
        RELAY_COLS: String(cols),
        RELAY_ROWS: String(rows),
        RELAY_SIGNAL_PROCESS_GROUP: shellSession ? '1' : '0',
        TERM: process.env.TERM ?? 'xterm-256color',
      },
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
    if (!terminalManager.attachChild(terminalId, child)) {
      child.kill();
      throw new Error('Could not attach the terminal process.');
    }
  } catch (error) {
    terminalManager.cancelReservation(terminalId);
    return {
      ok: false,
      output: error instanceof Error ? error.message : String(error),
    };
  }
  for (const stream of [
    child.stdin,
    child.stdout,
    child.stderr,
    child.stdio[3],
  ])
    stream?.on('error', () => undefined);
  const window = BrowserWindow.fromWebContents(event.sender);

  const send = (channel, payload) => {
    if (!event.sender.isDestroyed()) event.sender.send(channel, payload);
  };
  managed._send = send;

  const relayOutput = (stream) => (dataBuf) => {
    if (managed.status === 'starting') {
      const sequence = terminalManager.setStatus(terminalId, 'running');
      send('relay:terminal-status', {
        terminalId,
        status: 'running',
        sequence,
      });
    }
    const res = terminalManager.appendOutput(terminalId, dataBuf, stream);
    if (!res) return;
    flushTerminalOutput(managed);
  };

  child.stdout.on('data', relayOutput('stdout'));
  child.stderr.on('data', relayOutput('stderr'));

  const finalize = (code, signal, error) => {
    terminalManager.flushOutput(terminalId);
    if (!terminalManager.finalize(terminalId, code, signal, error)) return;

    if (managed._stopTimers) {
      for (const t of managed._stopTimers) globalThis.clearTimeout(t);
      managed._stopTimers = [];
    }

    managed.pendingExit = {
      terminalId,
      code,
      signal,
      error,
      status: managed.status,
      sequence: managed.sequence,
    };
    flushTerminalOutput(managed);

    if (!shellSession) {
      const success = managed.status === 'completed';
      showNativeNotification(
        window,
        success ? 'agent-success' : 'agent-failure',
        { provider: agent },
        success,
      );
    }
  };

  child.once('error', (error) => finalize(null, null, error.message));
  child.once('close', (code, signal) => finalize(code, signal, null));
  const terminal = terminalManager
    .inventory(event.sender.id)
    .find((item) => item.id === terminalId);
  return {
    ok: true,
    terminalId,
    terminal,
    output: shellSession
      ? 'Opened a shell terminal.'
      : `Started ${agent} in the Relay terminal.`,
  };
}

function registerIpc() {
  ipcMain.handle('relay:select-project', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('relay:command', async (event, request) => {
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
    if (request.command === 'recover' && terminalForProject(request.project))
      return {
        ok: false,
        output: 'Stop the active desktop provider before recovering its run.',
      };
    if (request.command === 'recover') {
      const confirmation = await dialog.showMessageBox(
        BrowserWindow.fromWebContents(event.sender),
        {
          type: 'warning',
          title: 'Recover interrupted run?',
          message: 'Recover only if the provider process is no longer running.',
          detail:
            'Recovery releases the worktree lease. A provider that is still writing could conflict with the next session.',
          buttons: ['Cancel', 'Recover Run'],
          defaultId: 0,
          cancelId: 0,
        },
      );
      if (confirmation.response !== 1)
        return { ok: false, output: 'Recovery cancelled.' };
      args.push('--force');
    }
    const result = await runCli(request.project, request.command, args);
    if (result.ok && ['finish', 'checkpoint'].includes(request.command)) {
      showNativeNotification(
        BrowserWindow.fromWebContents(event.sender),
        request.command === 'finish' ? 'task-completed' : 'checkpoint-created',
        {},
        true,
      );
    }
    return result;
  });
  ipcMain.handle('relay:usage', async (_event, request) => {
    if (!request || !validProject(request.project))
      return { ok: false, output: 'Invalid project.' };
    const result = await runCli(request.project, 'usage', [
      '--plans-only',
      '--json',
    ]);
    if (!result.ok) return result;
    try {
      const data = sanitizeUsage(JSON.parse(result.stdout));
      return data
        ? { ok: true, data }
        : { ok: false, output: 'Could not read usage.' };
    } catch {
      return { ok: false, output: result.output || 'Could not read usage.' };
    }
  });
  ipcMain.handle('relay:activity', async (event, request) => {
    if (!validProject(request?.project))
      return { ok: false, output: 'Invalid project directory.' };
    const root = repositoryRoot(request.project);
    if (!root) return { ok: false, output: 'Not a Git repository.' };
    const activeProject = usageSubscriptions.get(event.sender.id)?.project;
    const activeRoot = activeProject && repositoryRoot(activeProject);
    if (!activeRoot || activeRoot !== root)
      return { ok: false, output: 'Project access is not active.' };
    try {
      return {
        ok: true,
        data: await readValidatedActivitySnapshot(globalActivityFile()),
      };
    } catch {
      return { ok: false, output: 'Could not read the Rirei activity feed.' };
    }
  });

  ipcMain.handle('relay:dashboard', async (_event, request) => {
    if (!request || !validProject(request.project))
      return { ok: false, output: 'Invalid project.' };
    const result = await runCli(request.project, 'status', ['--json']);
    if (!result.ok) return result;
    try {
      return { ok: true, data: JSON.parse(result.stdout) };
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
      return { ok: true, data: JSON.parse(result.stdout) };
    } catch {
      return { ok: false, output: 'Could not read agent capabilities.' };
    }
  });
  ipcMain.handle('relay:shell', async (event, request) => {
    const projectRoot = request && repositoryRoot(request.project);
    if (!projectRoot)
      return { ok: false, output: 'Choose a valid Git project folder.' };
    let branchLabel = currentBranchLabel(projectRoot);
    if (existsSync(path.join(projectRoot, '.relay', 'state.json'))) {
      const projection = await readWorkspaceProjection(projectRoot);
      if (!projection.ok) return projection;
      if (projection.data.mainClaimed)
        return {
          ok: false,
          output:
            'The main working tree is already claimed by an agent session.',
        };
      branchLabel = projection.data.mainBranchLabel;
    }
    return startTerminal(event, projectRoot, 'shell', 'shell', request.size, {
      branchLabel,
    });
  });
  ipcMain.handle('relay:interactive', async (event, request) => {
    if (
      !request ||
      !validProject(request.project) ||
      !['run', 'switch', 'resume'].includes(request.command) ||
      !agents.has(request.agent) ||
      (request.command === 'resume' &&
        !['claude', 'codex'].includes(request.agent)) ||
      (request.command === 'resume' &&
        !['latest', 'picker', 'id'].includes(request.resumeTargetKind)) ||
      (request.resumeTargetKind === 'id' &&
        (typeof request.resumeTargetValue !== 'string' ||
          !validSelection(request.resumeTargetValue))) ||
      (request.command === 'resume' &&
        request.agent === 'codex' &&
        request.fork === true) ||
      !validSelection(request.model) ||
      !validSelection(request.effort, 20) ||
      (request.workspace !== undefined &&
        !validSelection(request.workspace, 255))
    )
      return { ok: false, output: 'Invalid interactive command.' };

    const projectRoot = repositoryRoot(request.project);
    if (!projectRoot)
      return { ok: false, output: 'Choose a valid Git project folder.' };
    const preflight = terminalPreflight(projectRoot);
    if (preflight) return preflight;
    const workspaceProjection = await readWorkspaceProjection(projectRoot);
    if (!workspaceProjection.ok) return workspaceProjection;
    let branchLabel = workspaceProjection.data.mainBranchLabel;
    if (request.workspace) {
      const workspace = workspaceProjection.data.workspaces.find(
        (item) => item.id === request.workspace,
      );
      if (!workspace?.selectable)
        return {
          ok: false,
          output: 'The selected workspace is unavailable or already claimed.',
        };
      branchLabel = workspace.branchLabel;
    } else if (workspaceProjection.data.mainClaimed) {
      return {
        ok: false,
        output:
          'The main working tree is already claimed. Select or create an isolated workspace.',
      };
    }

    return startTerminal(
      event,
      projectRoot,
      request.command,
      request.agent,
      request.size,
      {
        model: request.model,
        effort: request.effort,
        resumeTargetKind: request.resumeTargetKind,
        resumeTargetValue: request.resumeTargetValue,
        fork: request.fork === true,
        workspace: request.workspace,
        branchLabel,
      },
    );
  });
  ipcMain.handle('relay:history', async (_event, request) => {
    if (
      !request ||
      !validProject(request.project) ||
      (request.query !== undefined &&
        (typeof request.query !== 'string' || request.query.length > 500))
    )
      return { ok: false, output: 'Invalid history request.' };
    const args = [];
    if (request.query?.trim()) args.push(request.query.trim());
    args.push('--json');
    const result = await runCli(request.project, 'history', args);
    if (!result.ok) return result;
    try {
      return { ok: true, data: JSON.parse(result.stdout) };
    } catch {
      return { ok: false, output: 'Could not read task history.' };
    }
  });
  ipcMain.handle('relay:checkpoints', async (_event, request) => {
    if (!request || !validProject(request.project))
      return { ok: false, output: 'Invalid project.' };
    const result = await runCli(request.project, 'checkpoints', ['--json']);
    if (!result.ok) return result;
    try {
      return { ok: true, data: JSON.parse(result.stdout) };
    } catch {
      return { ok: false, output: 'Could not read checkpoint history.' };
    }
  });
  ipcMain.handle('relay:checkpoint-diff', async (_event, request) => {
    if (
      !request ||
      !validProject(request.project) ||
      typeof request.id !== 'string' ||
      request.id.length > 80 ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d{3,}$/.test(request.id)
    )
      return { ok: false, output: 'Invalid checkpoint request.' };
    const result = await runCli(request.project, 'checkpoint-diff', [
      request.id,
      '--json',
    ]);
    if (!result.ok) return result;
    try {
      return { ok: true, data: JSON.parse(result.stdout) };
    } catch {
      return { ok: false, output: 'Could not read checkpoint diff.' };
    }
  });

  ipcMain.handle('relay:workspace-list', async (_event, request) => {
    const projectRoot = request && repositoryRoot(request.project);
    if (!projectRoot) return { ok: false, output: 'Invalid project.' };
    return readWorkspaceProjection(projectRoot);
  });

  ipcMain.handle('relay:workspace-create', async (_event, request) => {
    const projectRoot = request && repositoryRoot(request.project);
    if (
      !request ||
      !projectRoot ||
      !['implement', 'review', 'verify', 'investigate'].includes(
        request.role,
      ) ||
      typeof request.operationId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        request.operationId,
      )
    )
      return { ok: false, output: 'Invalid project or role.' };
    const args = [
      'create',
      '--role',
      request.role,
      '--operation-id',
      request.operationId,
      '--json',
    ];
    if (request.slug) {
      if (!validSelection(request.slug, 80))
        return { ok: false, output: 'Invalid slug.' };
      args.push('--slug', request.slug);
    }
    const result = await runCli(projectRoot, 'workspace', args);
    if (!result.ok) return result;
    try {
      const parsed = JSON.parse(result.stdout);
      if (
        !parsed ||
        typeof parsed.id !== 'string' ||
        typeof parsed.branch !== 'string'
      )
        return { ok: false, output: 'Invalid workspace create output.' };
      return {
        ok: true,
        data: { id: parsed.id, branchLabel: parsed.branch },
      };
    } catch {
      return { ok: false, output: 'Could not parse workspace create output.' };
    }
  });

  ipcMain.on('relay:set-active-project', setActiveProject);
  ipcMain.on('relay:terminal-input', (event, request) => {
    const child = ownedTerminal(event, request?.terminalId)?.child;
    if (
      child?.stdin.writable &&
      typeof request?.data === 'string' &&
      request.data.length <= 65_536
    )
      safeStreamWrite(child.stdin, request.data);
  });
  ipcMain.on('relay:terminal-resize', (event, request) => {
    const child = ownedTerminal(event, request?.terminalId)?.child;
    const control = child?.stdio[3];
    if (control?.writable) {
      const { cols, rows } = terminalSize(request?.size);
      safeStreamWrite(
        control,
        `${JSON.stringify({ action: 'resize', cols, rows })}\n`,
      );
    }
  });

  ipcMain.on('relay:terminal-output-ack', (event, request) => {
    const terminal = ownedTerminal(event, request?.terminalId);
    if (
      !terminal ||
      !terminalManager.acknowledgeOutput(
        terminal.id,
        request?.sequence,
        event.sender.id,
      )
    )
      return;
    flushTerminalOutput(terminal);
  });

  ipcMain.handle('relay:terminal-stop', (event, request) => {
    const t = ownedTerminal(event, request?.terminalId);
    if (!t || !t.child)
      return { ok: false, output: 'No terminal session is running.' };
    const sequence = terminalManager.setStatus(t.id, 'stopping');
    t._send?.('relay:terminal-status', {
      terminalId: t.id,
      status: 'stopping',
      sequence,
    });
    escalateStop(t.child, t);
    return { ok: true, output: 'Stop escalation initiated.' };
  });

  ipcMain.handle('relay:terminal-inventory', (event) => {
    return terminalManager.inventory(event.sender.id);
  });

  ipcMain.on('relay:renderer-ready', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) return;
    readyRenderers.add(event.sender.id);
    flushDeepLinkIntents();
  });

  ipcMain.handle('relay:terminal-close', (event, request) => {
    return {
      ok: terminalManager.remove(request?.terminalId, event.sender.id),
    };
  });

  ipcMain.handle('relay:terminal-hide', (event, request) => {
    const t = ownedTerminal(event, request?.terminalId);
    if (t) {
      terminalManager.setHidden(t.id, true, event.sender.id);
      return { ok: true };
    }
    return { ok: false };
  });

  ipcMain.handle('relay:terminal-show', (event, request) => {
    const terminal = ownedTerminal(event, request?.terminalId);
    if (!terminal) return { ok: false };
    terminalManager.setHidden(terminal.id, false, event.sender.id);
    return { ok: true };
  });

  ipcMain.handle('relay:terminal-interrupt', (event, request) => {
    const t = ownedTerminal(event, request?.terminalId);
    if (!t || !t.child)
      return { ok: false, output: 'No terminal session is running.' };
    const control = t.child.stdio[3];
    if (safeStreamWrite(control, terminalControlFrame('interrupt'))) {
      return { ok: true, output: 'Interrupt sent.' };
    }
    return { ok: false, output: 'Cannot send interrupt.' };
  });
}

function stopOwnedTerminals(ownerWebContentsId) {
  for (const terminal of terminalManager.getAllForOwner(ownerWebContentsId)) {
    if (terminal.finalized || !terminal.child) continue;
    terminalManager.setStatus(terminal.id, 'stopping');
    escalateStop(terminal.child, terminal);
  }
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
  const senderId = window.webContents.id;
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('did-start-loading', () => {
    readyRenderers.delete(senderId);
  });
  window.webContents.on('render-process-gone', () => {
    readyRenderers.delete(senderId);
    stopOwnedTerminals(senderId);
  });
  window.on('close', (event) => {
    const running = terminalManager.runningCount();
    if (running === 0) return;
    event.preventDefault();
    dialog.showMessageBoxSync(window, {
      type: 'warning',
      title: 'Providers still running',
      message: `Stop the active providers before closing Rirei. (${running} active)`,
      detail:
        'Closing now would make process ownership uncertain and could leave the provider writing without a controller.',
      buttons: ['Keep Rirei Open'],
      defaultId: 0,
    });
  });
  window.webContents.once('destroyed', () => {
    readyRenderers.delete(senderId);
    clearUsageSubscription(senderId);
    stopOwnedTerminals(senderId);
  });
  window.loadFile(path.join(here, 'renderer', 'index.html'));
  return window;
}

function showAndFocusWindow(window) {
  if (!window || window.isDestroyed()) return false;
  try {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    return true;
  } catch {
    return false;
  }
}

function availableRireiWindow() {
  return (
    BrowserWindow.getFocusedWindow() ??
    BrowserWindow.getAllWindows().find((window) => !window.isDestroyed()) ??
    null
  );
}

function ownerWindow(terminalId) {
  const ownerWebContentsId = terminalOwnerWebContentsId(
    terminalManager.terminals,
    terminalId,
  );
  if (ownerWebContentsId === null) return null;
  return (
    BrowserWindow.getAllWindows().find(
      (window) =>
        !window.isDestroyed() && window.webContents.id === ownerWebContentsId,
    ) ?? null
  );
}

function deliverDeepLinkIntent(intent) {
  const ownerWebContentsId = terminalOwnerWebContentsId(
    terminalManager.terminals,
    intent.terminalId,
  );
  const terminalWindow =
    ownerWebContentsId === null ? null : ownerWindow(intent.terminalId);
  const found = terminalWindow !== null;
  let window = found ? terminalWindow : availableRireiWindow();
  if (!window && !found && appReady) window = createWindow();
  if (!showAndFocusWindow(window)) return false;
  if (!readyRenderers.has(window.webContents.id)) return false;
  if (found && window.webContents.id !== ownerWebContentsId) return false;
  try {
    window.webContents.send('relay:deep-link', {
      type: found ? 'terminal' : 'not-found',
      terminalId: intent.terminalId,
    });
    return true;
  } catch {
    return false;
  }
}

function flushDeepLinkIntents() {
  if (!appReady) return;
  deepLinkIntents.flush(deliverDeepLinkIntent);
}

function queueDeepLinkUrl(url) {
  const intent = parseTerminalDeepLink(url);
  if (!intent) return false;
  deepLinkIntents.enqueue(intent);
  flushDeepLinkIntents();
  return true;
}

function queueDeepLinksFromArgv(argv) {
  const intents = terminalDeepLinksFromArgv(argv);
  for (const intent of intents) deepLinkIntents.enqueue(intent);
  flushDeepLinkIntents();
  return intents.length;
}

function focusAvailableRireiWindow() {
  let window = availableRireiWindow();
  if (!window && appReady) window = createWindow();
  showAndFocusWindow(window);
}

// macOS may emit open-url before Electron's ready event.
app.on('open-url', (event, url) => {
  event.preventDefault();
  queueDeepLinkUrl(url);
});

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  queueDeepLinksFromArgv(process.argv);

  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient('rirei', process.execPath, [
        path.resolve(process.argv[1]),
      ]);
    }
  } else {
    app.setAsDefaultProtocolClient('rirei');
  }

  app.on('second-instance', (_event, commandLine) => {
    if (queueDeepLinksFromArgv(commandLine) === 0) focusAvailableRireiWindow();
  });

  app.whenReady().then(() => {
    registerIpc();
    appReady = true;
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    flushDeepLinkIntents();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      flushDeepLinkIntents();
    });
  });

  app.on('before-quit', () => {
    appReady = false;
    readyRenderers.clear();
    for (const senderId of usageSubscriptions.keys())
      clearUsageSubscription(senderId);
    for (const notification of liveNotifications) notification.close();
    liveNotifications.clear();
  });

  app.on('window-all-closed', () => app.quit());
}
