import { app, BrowserWindow, dialog, ipcMain, Notification } from 'electron';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readValidatedActivitySnapshot } from './activity-snapshot.mjs';
import {
  DeepLinkIntentQueue,
  parseTerminalDeepLink,
  terminalDeepLinksFromArgv,
} from './deep-links.mjs';
import { createUsageAlertPolicy } from './usage-alert-policy.mjs';
import { TerminalDaemonClient } from './terminal-daemon-client.mjs';
import { listTerminalJournalProjects } from './terminal-journal.mjs';
import { sanitizeWorkspaceList } from './workspace-projection.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const agents = new Set([
  'claude',
  'codex',
  'gemini',
  'antigravity',
  'opencode',
]);
let terminalDaemon;
const rendererTerminals = new Map();
const terminalDeliveries = new Map();
const deepLinkIntents = new DeepLinkIntentQueue();
const readyRenderers = new Set();
let appReady = false;
let daemonReconnectTimer = null;

const usageSubscriptions = new Map();
const usageAlertPolicy = createUsageAlertPolicy();
const liveNotifications = new Set();
const USAGE_POLL_INTERVAL_MS = 60_000;
const providerNames = Object.freeze({
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  antigravity: 'Antigravity',
  opencode: 'OpenCode',
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

function daemonEntryPath() {
  const local = path.join(here, 'terminal-daemon.mjs');
  if (!app.isPackaged || (!local.includes('.asar') && existsSync(local)))
    return local;
  const unpacked = path.join(
    process.resourcesPath,
    'app.asar.unpacked',
    'desktop',
    'terminal-daemon.mjs',
  );
  if (existsSync(unpacked)) return unpacked;
  throw new Error('The packaged terminal daemon is missing.');
}

function daemonRuntimePaths() {
  const userData = app.getPath('userData');
  const hash = createHash('sha256').update(userData).digest('hex').slice(0, 16);
  return {
    descriptorPath: path.join(userData, 'terminal-daemon-v1.json'),
    socketPath: path.join(
      os.tmpdir(),
      `rirei-${process.getuid?.() ?? 0}-${hash}`,
      'pty-v1.sock',
    ),
  };
}

function nodePath() {
  for (const candidate of ['/usr/local/bin/node', '/opt/homebrew/bin/node']) {
    if (existsSync(candidate)) return candidate;
  }
  return 'node';
}

function providerPath() {
  const values = [
    path.join(app.getPath('home'), '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    process.env.PATH,
  ].filter(Boolean);
  return values
    .filter((value, index) => values.indexOf(value) === index)
    .join(path.delimiter);
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
  if (
    !value ||
    typeof value !== 'object' ||
    value.schemaVersion !== 2 ||
    !Array.isArray(value.plans)
  )
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
      !['available', 'stale', 'unknown', 'unsupported', 'error'].includes(
        plan.status,
      )
    )
      continue;
    const capturedAt = safeIso(plan.capturedAt);
    if (capturedAt === undefined) continue;
    const metrics = [];
    for (const metric of Array.isArray(plan.metrics) ? plan.metrics : []) {
      if (
        !metric ||
        typeof metric !== 'object' ||
        typeof metric.id !== 'string' ||
        metric.id.length < 1 ||
        metric.id.length > 80 ||
        !['quota', 'requests', 'tokens', 'credits', 'cost'].includes(
          metric.kind,
        ) ||
        !['percent', 'requests', 'tokens', 'credits', 'currency'].includes(
          metric.unit,
        ) ||
        !['available', 'stale'].includes(metric.status) ||
        !['live', 'sample_stale', 'window_expired', 'invalid_capture'].includes(
          metric.statusReason,
        )
      )
        continue;
      const numeric = {};
      let valid = true;
      for (const key of ['used', 'remaining', 'limit', 'retryAfterSeconds']) {
        if (metric[key] === undefined) continue;
        if (typeof metric[key] !== 'number' || !Number.isFinite(metric[key])) {
          valid = false;
          break;
        }
        numeric[key] = metric[key];
      }
      if (!valid) continue;
      const resetsAt = safeIso(metric.resetsAt);
      if (resetsAt === undefined) continue;
      const window =
        metric.window &&
        typeof metric.window.label === 'string' &&
        metric.window.label.length > 0 &&
        metric.window.label.length <= 80
          ? {
              label: metric.window.label,
              ...(Number.isInteger(metric.window.durationSeconds) &&
              metric.window.durationSeconds > 0
                ? { durationSeconds: metric.window.durationSeconds }
                : {}),
            }
          : undefined;
      metrics.push({
        id: metric.id,
        kind: metric.kind,
        unit: metric.unit,
        ...(window ? { window } : {}),
        ...numeric,
        resetsAt,
        status: metric.status,
        statusReason: metric.statusReason,
      });
    }
    const sanitized = {
      id: plan.id,
      displayName: providerNames[plan.id],
      status: plan.status,
      capturedAt,
      source:
        typeof plan.source === 'string' && plan.source.length <= 120
          ? plan.source
          : 'Unavailable',
      detail:
        typeof plan.detail === 'string' && plan.detail.length <= 300
          ? plan.detail
          : 'No current provider usage is available.',
      metrics,
    };
    const fiveHour = sanitizeUsageWindow(plan.fiveHour);
    const week = sanitizeUsageWindow(plan.week);
    if (fiveHour) sanitized.fiveHour = fiveHour;
    if (week) sanitized.week = week;
    plans.push(sanitized);
  }
  return {
    schemaVersion: 2,
    task: { title: taskTitle, status: taskStatus },
    plans,
  };
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
  void reconcileProjectWithDaemon(project);
  void pollUsage(subscription);
}

function daemonReconciliationArgs() {
  if (
    !terminalDaemon?.connected ||
    !terminalDaemon.daemonId ||
    !terminalDaemon.daemonPid ||
    !terminalDaemon.daemonBootId
  )
    return [];
  const terminalIds = [...terminalDaemon.inventory.values()]
    .filter((terminal) =>
      ['starting', 'running', 'waiting', 'stopping'].includes(terminal.status),
    )
    .map((terminal) => terminal.id);
  return [
    '--daemon-id',
    terminalDaemon.daemonId,
    '--daemon-pid',
    String(terminalDaemon.daemonPid),
    '--daemon-boot-id',
    terminalDaemon.daemonBootId,
    ...(terminalIds.length > 0 ? ['--terminal-id', ...terminalIds] : []),
  ];
}

function reconcileProjectWithDaemon(project) {
  if (!validProjectDirectory(project)) return Promise.resolve();
  return runCli(project, 'reconcile', daemonReconciliationArgs()).then(
    () => undefined,
  );
}

async function reconcileDaemonProjects() {
  const projects = new Set(
    [...(terminalDaemon?.inventory.values() ?? [])]
      .map((terminal) => terminal.project)
      .filter(validProjectDirectory),
  );
  for (const project of await listTerminalJournalProjects().catch(() => []))
    if (validProjectDirectory(project)) projects.add(project);
  for (const project of projects) await reconcileProjectWithDaemon(project);
}

function terminalSize(size) {
  const clamp = (value, fallback) =>
    Number.isInteger(value) && value >= 1 && value <= 10000 ? value : fallback;
  return {
    cols: clamp(size?.cols, 80),
    rows: clamp(size?.rows, 24),
  };
}

function terminalForProject(project) {
  return [...(terminalDaemon?.inventory.values() ?? [])].find(
    (terminal) =>
      terminal.project === project &&
      ['starting', 'running', 'waiting', 'stopping'].includes(terminal.status),
  );
}

function ownedTerminal(event, terminalId) {
  if (typeof terminalId !== 'string') return null;
  return rendererTerminals.get(event.sender.id)?.has(terminalId)
    ? terminalDaemon.inventory.get(terminalId)
    : null;
}

function terminalOwnerId(terminalId) {
  for (const [senderId, terminalIds] of rendererTerminals)
    if (terminalIds.has(terminalId)) return senderId;
  return null;
}

function deliveryKey(senderId, terminalId) {
  return `${senderId}:${terminalId}`;
}

function finalTerminal(status) {
  return ['completed', 'failed', 'cancelled', 'orphaned'].includes(status);
}

function publicRendererTerminal(
  terminal,
  outputCursor = terminal.oldestCursor ?? 0,
) {
  return {
    id: terminal.id,
    provider: terminal.provider,
    workspaceId: terminal.workspaceId,
    branchLabel: terminal.branchLabel,
    projectLabel: terminal.projectLabel,
    status: terminal.status,
    lifecycleState: terminal.lifecycleState,
    attentionKind: terminal.attentionKind,
    activeRuntimeSeconds: terminal.activeRuntimeSeconds,
    runtimeSequence: terminal.runtimeSequence,
    hidden: terminal.hidden,
    createdAt: terminal.createdAt,
    lastActivityAt: terminal.lastActivityAt,
    sequence: terminal.sequence,
    outputCursor,
    oldestCursor: terminal.oldestCursor,
    nextCursor: terminal.nextCursor,
    dimensions: terminal.dimensions,
    bridge: terminal.bridge,
    bridgeError: terminal.bridgeError,
    exitCode: terminal.exitCode,
    signal: terminal.signal,
    error: terminal.error,
    providerResult: terminal.providerResult,
    bridgeStatus: terminal.bridgeStatus,
  };
}

function normalizedStatus(terminal) {
  return {
    terminalId: terminal.id,
    status: terminal.status,
    lifecycleState: terminal.lifecycleState,
    attentionKind: terminal.attentionKind,
    activeRuntimeSeconds: terminal.activeRuntimeSeconds,
    runtimeSequence: terminal.runtimeSequence,
    sequence: terminal.sequence,
    hidden: terminal.hidden,
    dimensions: terminal.dimensions,
    bridge: terminal.bridge,
    bridgeError: terminal.bridgeError,
  };
}

function normalizedExit(terminal) {
  return {
    terminalId: terminal.id,
    status: terminal.status,
    lifecycleState: terminal.lifecycleState,
    attentionKind: terminal.attentionKind,
    activeRuntimeSeconds: terminal.activeRuntimeSeconds,
    runtimeSequence: terminal.runtimeSequence,
    sequence: terminal.sequence,
    code: terminal.exitCode,
    signal: terminal.signal,
    error: terminal.error,
    providerResult: terminal.providerResult,
    bridgeStatus: terminal.bridgeStatus,
    bridgeError: terminal.bridgeError,
    nextCursor: terminal.nextCursor,
  };
}

function rendererSender(senderId) {
  return BrowserWindow.getAllWindows().find(
    (window) =>
      !window.isDestroyed() &&
      !window.webContents.isDestroyed() &&
      window.webContents.id === senderId,
  )?.webContents;
}

function resetRendererDeliveries(senderId) {
  for (const key of terminalDeliveries.keys())
    if (key.startsWith(`${senderId}:`)) terminalDeliveries.delete(key);
}

function releaseRenderer(senderId) {
  readyRenderers.delete(senderId);
  rendererTerminals.delete(senderId);
  resetRendererDeliveries(senderId);
}

function getActiveTerminalClaims(project) {
  const leases = new Set();
  for (const t of terminalDaemon?.inventory.values() ?? []) {
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

function sendPendingExit(sender, terminalId, delivery) {
  if (
    !delivery.pendingExit ||
    delivery.inFlight ||
    delivery.cursor < delivery.pendingExit.nextCursor
  )
    return false;
  const terminal = delivery.pendingExit;
  delivery.pendingExit = null;
  sender.send('relay:terminal-exit', normalizedExit(terminal));
  return true;
}

async function pumpTerminal(sender, terminalId) {
  if (
    sender.isDestroyed() ||
    !readyRenderers.has(sender.id) ||
    !rendererTerminals.get(sender.id)?.has(terminalId)
  )
    return;
  const key = deliveryKey(sender.id, terminalId);
  const delivery = terminalDeliveries.get(key);
  if (!delivery || delivery.pumping || delivery.inFlight) return;
  if (sendPendingExit(sender, terminalId, delivery)) return;
  delivery.pumping = true;
  try {
    const batch = await terminalDaemon.attach(terminalId, delivery.cursor);
    if (
      terminalDeliveries.get(key) !== delivery ||
      sender.isDestroyed() ||
      !readyRenderers.has(sender.id)
    )
      return;
    delivery.targetCursor = Math.max(delivery.targetCursor, batch.nextCursor);
    if (!batch.data && !batch.truncated) {
      sendPendingExit(sender, terminalId, delivery);
      return;
    }
    delivery.inFlight = {
      startCursor: batch.startCursor,
      endCursor: batch.endCursor,
    };
    sender.send('relay:terminal-data', {
      terminalId,
      dataBase64: batch.data,
      startCursor: batch.startCursor,
      endCursor: batch.endCursor,
      nextCursor: batch.nextCursor,
      truncated: batch.truncated,
    });
  } catch (error) {
    if (error?.code !== 'not_found' && error?.daemonCode !== 'not_found')
      scheduleDaemonReconnect();
  } finally {
    delivery.pumping = false;
  }
}

function wakeTerminalOwners(terminalId, nextCursor) {
  for (const [senderId, terminalIds] of rendererTerminals) {
    if (!terminalIds.has(terminalId)) continue;
    const delivery = terminalDeliveries.get(deliveryKey(senderId, terminalId));
    if (delivery && Number.isSafeInteger(nextCursor))
      delivery.targetCursor = Math.max(delivery.targetCursor, nextCursor);
    const sender = rendererSender(senderId);
    if (sender) void pumpTerminal(sender, terminalId);
  }
}

function forwardTerminalStatus(terminal) {
  for (const [senderId, terminalIds] of rendererTerminals) {
    if (!terminalIds.has(terminal.id) || !readyRenderers.has(senderId))
      continue;
    rendererSender(senderId)?.send(
      'relay:terminal-status',
      normalizedStatus(terminal),
    );
  }
}

function queueTerminalExit(terminal) {
  for (const [senderId, terminalIds] of rendererTerminals) {
    if (!terminalIds.has(terminal.id)) continue;
    const key = deliveryKey(senderId, terminal.id);
    const delivery = terminalDeliveries.get(key);
    if (!delivery) continue;
    delivery.pendingExit = terminal;
    delivery.targetCursor = Math.max(
      delivery.targetCursor,
      terminal.nextCursor,
    );
    const sender = rendererSender(senderId);
    if (sender) {
      const window = BrowserWindow.fromWebContents(sender);
      if (terminal.provider !== 'shell') {
        const success = terminal.status === 'completed';
        showNativeNotification(
          window,
          success ? 'agent-success' : 'agent-failure',
          { provider: terminal.provider },
          success,
        );
      }
      void pumpTerminal(sender, terminal.id);
    }
  }
}

function scheduleDaemonReconnect() {
  if (daemonReconnectTimer || !terminalDaemon || terminalDaemon.connected)
    return;
  daemonReconnectTimer = globalThis.setTimeout(async () => {
    daemonReconnectTimer = null;
    try {
      await terminalDaemon.connectOrStart();
    } catch {
      scheduleDaemonReconnect();
    }
  }, 250);
}

function wireTerminalDaemon() {
  terminalDaemon.on('output_available', (event) =>
    wakeTerminalOwners(event.terminalId, event.nextCursor),
  );
  for (const eventName of ['status', 'resized', 'interrupted', 'hidden'])
    terminalDaemon.on(eventName, (event) => {
      if (!event.terminal) return;
      forwardTerminalStatus(event.terminal);
    });
  terminalDaemon.on('exit', (event) => {
    if (event.terminal) queueTerminalExit(event.terminal);
  });
  terminalDaemon.on('forgotten', (event) => {
    for (const terminalIds of rendererTerminals)
      terminalIds[1].delete(event.terminalId);
  });
  terminalDaemon.on('connected', () => {
    reconcileDaemonProjects();
    for (const [senderId, terminalIds] of rendererTerminals) {
      const sender = rendererSender(senderId);
      if (!sender) continue;
      for (const terminalId of terminalIds) {
        const terminal = terminalDaemon.inventory.get(terminalId);
        const delivery = terminalDeliveries.get(
          deliveryKey(senderId, terminalId),
        );
        if (!terminal || !delivery) continue;
        delivery.targetCursor = Math.max(
          delivery.targetCursor,
          terminal.nextCursor,
        );
        if (finalTerminal(terminal.status)) delivery.pendingExit = terminal;
        void pumpTerminal(sender, terminalId);
      }
    }
  });
  terminalDaemon.on('disconnected', scheduleDaemonReconnect);
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

async function startTerminal(event, project, command, agent, size, selection) {
  const shellSession = command === 'shell';
  if (!shellSession) {
    const preflight = terminalPreflight(project);
    if (preflight) return preflight;
  }
  const workspaceId = selection.workspace || 'default';
  if (workspaceId !== 'default' && command !== 'run' && command !== 'resume')
    return {
      ok: false,
      output: `The '${command}' command does not support workspace launches.`,
    };
  try {
    const terminal = await terminalDaemon.start({
      project,
      kind: shellSession ? 'shell' : 'agent',
      command,
      agent,
      workspaceId,
      branchLabel:
        selection.branchLabel ||
        (workspaceId === 'default' ? 'main' : workspaceId),
      model: selection.model,
      effort: selection.effort,
      resumeTargetKind: selection.resumeTargetKind,
      resumeTargetValue: selection.resumeTargetValue,
      fork: selection.fork === true,
      shell: loginShellPath(),
      size: terminalSize(size),
    });
    terminalDaemon.inventory.set(terminal.id, terminal);
    if (!rendererTerminals.has(event.sender.id))
      rendererTerminals.set(event.sender.id, new Set());
    rendererTerminals.get(event.sender.id).add(terminal.id);
    terminalDeliveries.set(deliveryKey(event.sender.id, terminal.id), {
      cursor: terminal.oldestCursor ?? 0,
      targetCursor: terminal.nextCursor ?? 0,
      inFlight: null,
      pumping: false,
      pendingExit: finalTerminal(terminal.status) ? terminal : null,
    });
    void pumpTerminal(event.sender, terminal.id);
    return {
      ok: true,
      terminalId: terminal.id,
      terminal: publicRendererTerminal(terminal),
      output: shellSession
        ? 'Opened a shell terminal.'
        : `Started ${agent} in the Relay terminal.`,
    };
  } catch (error) {
    return {
      ok: false,
      output: error instanceof Error ? error.message : String(error),
    };
  }
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
    const reconciliation = await runCli(request.project, 'reconcile', [
      '--json',
      ...daemonReconciliationArgs(),
    ]);
    const result = await runCli(request.project, 'status', ['--json']);
    if (!result.ok) return result;
    try {
      return {
        ok: true,
        data: {
          ...JSON.parse(result.stdout),
          reconciliation: reconciliation.ok
            ? JSON.parse(reconciliation.stdout)
            : [],
        },
      };
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
    let adapterCapabilities;
    if (request?.command === 'resume' && agents.has(request.agent)) {
      const catalogResult = await runCli(request.project, 'agents', ['--json']);
      try {
        adapterCapabilities = catalogResult.ok
          ? JSON.parse(catalogResult.stdout).agents?.find(
              (entry) => entry.id === request.agent,
            )
          : undefined;
      } catch {
        adapterCapabilities = undefined;
      }
    }
    if (
      !request ||
      !validProject(request.project) ||
      !['run', 'switch', 'resume'].includes(request.command) ||
      !agents.has(request.agent) ||
      (request.command === 'resume' &&
        !['latest', 'picker', 'id'].includes(request.resumeTargetKind)) ||
      (request.command === 'resume' &&
        !adapterCapabilities?.resumeCapabilities?.targets?.includes(
          request.resumeTargetKind,
        )) ||
      (request.resumeTargetKind === 'id' &&
        (typeof request.resumeTargetValue !== 'string' ||
          !validSelection(request.resumeTargetValue))) ||
      (request.command === 'resume' &&
        request.fork === true &&
        adapterCapabilities?.resumeCapabilities?.supportsFork !== true) ||
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
    if (
      ownedTerminal(event, request?.terminalId) &&
      typeof request?.data === 'string' &&
      request.data.length <= 65_536
    )
      void terminalDaemon
        .write(request.terminalId, request.data)
        .catch(scheduleDaemonReconnect);
  });
  ipcMain.on('relay:terminal-resize', (event, request) => {
    if (!ownedTerminal(event, request?.terminalId)) return;
    void terminalDaemon
      .resize(request.terminalId, terminalSize(request?.size))
      .catch(scheduleDaemonReconnect);
  });
  ipcMain.on('relay:terminal-attention', (event, request) => {
    const terminal = ownedTerminal(event, request?.terminalId);
    if (
      !terminal ||
      terminal.provider === 'shell' ||
      finalTerminal(terminal.status)
    )
      return;
    void terminalDaemon
      .setWaiting(terminal.id, 'input')
      .catch(scheduleDaemonReconnect);
  });
  ipcMain.on('relay:terminal-output-ack', (event, request) => {
    const terminal = ownedTerminal(event, request?.terminalId);
    const delivery = terminalDeliveries.get(
      deliveryKey(event.sender.id, request?.terminalId),
    );
    if (!terminal || !delivery?.inFlight) return;
    const cursor = request?.cursor ?? request?.sequence;
    if (cursor !== delivery.inFlight.endCursor) return;
    delivery.cursor = cursor;
    delivery.inFlight = null;
    void pumpTerminal(event.sender, terminal.id);
  });
  ipcMain.handle('relay:terminal-stop', async (event, request) => {
    const terminal = ownedTerminal(event, request?.terminalId);
    if (!terminal || finalTerminal(terminal.status))
      return { ok: false, output: 'No terminal session is running.' };
    try {
      await terminalDaemon.stop(terminal.id);
      return { ok: true, output: 'Stop escalation initiated.' };
    } catch (error) {
      scheduleDaemonReconnect();
      return {
        ok: false,
        output: error instanceof Error ? error.message : String(error),
      };
    }
  });
  ipcMain.handle('relay:terminal-inventory', async (event) => {
    const inventory = await terminalDaemon.refreshInventory();
    if (!rendererTerminals.has(event.sender.id))
      rendererTerminals.set(event.sender.id, new Set());
    const owned = rendererTerminals.get(event.sender.id);
    const available = [];
    resetRendererDeliveries(event.sender.id);
    for (const terminal of inventory) {
      const ownerId = terminalOwnerId(terminal.id);
      if (ownerId !== null && ownerId !== event.sender.id) continue;
      owned.add(terminal.id);
      const cursor = terminal.oldestCursor ?? 0;
      terminalDeliveries.set(deliveryKey(event.sender.id, terminal.id), {
        cursor,
        targetCursor: terminal.nextCursor ?? cursor,
        inFlight: null,
        pumping: false,
        pendingExit: finalTerminal(terminal.status) ? terminal : null,
      });
      available.push(publicRendererTerminal(terminal, cursor));
    }
    for (const terminalId of [...owned])
      if (!available.some((terminal) => terminal.id === terminalId))
        owned.delete(terminalId);
    return available;
  });
  ipcMain.on('relay:renderer-ready', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) return;
    readyRenderers.add(event.sender.id);
    for (const terminalId of rendererTerminals.get(event.sender.id) ?? [])
      void pumpTerminal(event.sender, terminalId);
    flushDeepLinkIntents();
  });
  ipcMain.handle('relay:terminal-close', async (event, request) => {
    const terminal = ownedTerminal(event, request?.terminalId);
    if (!terminal || !finalTerminal(terminal.status)) return { ok: false };
    try {
      await terminalDaemon.forget(terminal.id);
      rendererTerminals.get(event.sender.id)?.delete(terminal.id);
      terminalDeliveries.delete(deliveryKey(event.sender.id, terminal.id));
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });
  ipcMain.handle('relay:terminal-hide', async (event, request) => {
    const terminal = ownedTerminal(event, request?.terminalId);
    if (!terminal) return { ok: false };
    try {
      await terminalDaemon.setHidden(terminal.id, true);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });
  ipcMain.handle('relay:terminal-show', async (event, request) => {
    const terminal = ownedTerminal(event, request?.terminalId);
    if (!terminal) return { ok: false };
    try {
      await terminalDaemon.setHidden(terminal.id, false);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });
  ipcMain.handle('relay:terminal-interrupt', async (event, request) => {
    const terminal = ownedTerminal(event, request?.terminalId);
    if (!terminal || finalTerminal(terminal.status))
      return { ok: false, output: 'No terminal session is running.' };
    try {
      await terminalDaemon.interrupt(terminal.id);
      return { ok: true, output: 'Interrupt sent.' };
    } catch {
      return { ok: false, output: 'Cannot send interrupt.' };
    }
  });
}

// macOS composites the vibrancy material behind the web contents, so the
// window background stays clear and the renderer paints its own scrims on
// top. Every other platform keeps the original opaque background.
function windowMaterial() {
  if (process.platform !== 'darwin') return { backgroundColor: '#000000' };
  return {
    backgroundColor: '#00000000',
    vibrancy: 'under-window',
    visualEffectState: 'active',
  };
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 720,
    minHeight: 560,
    titleBarStyle: 'hiddenInset',
    ...windowMaterial(),
    show: false,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Without an opaque background, showing before first paint reveals the bare
  // vibrancy material. Every caller either waits for this or shows explicitly.
  window.once('ready-to-show', () => {
    if (!window.isDestroyed()) window.show();
  });
  const senderId = window.webContents.id;
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('did-start-loading', () => {
    readyRenderers.delete(senderId);
    resetRendererDeliveries(senderId);
  });
  window.webContents.on('render-process-gone', () => {
    releaseRenderer(senderId);
  });
  window.webContents.once('destroyed', () => {
    clearUsageSubscription(senderId);
    releaseRenderer(senderId);
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
  const ownerWebContentsId = terminalOwnerId(terminalId);
  if (ownerWebContentsId === null) return null;
  return (
    BrowserWindow.getAllWindows().find(
      (window) =>
        !window.isDestroyed() && window.webContents.id === ownerWebContentsId,
    ) ?? null
  );
}

function deliverDeepLinkIntent(intent) {
  const ownerWebContentsId = terminalOwnerId(intent.terminalId);
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

  app
    .whenReady()
    .then(async () => {
      const runtime = daemonRuntimePaths();
      terminalDaemon = new TerminalDaemonClient({
        executable: process.execPath,
        runAsNode: true,
        entry: daemonEntryPath(),
        bridgePath: ptyBridgePath(),
        cliPath: cliPath(),
        nodePath: nodePath(),
        pathValue: providerPath(),
        ...runtime,
      });
      wireTerminalDaemon();
      await terminalDaemon.connectOrStart();
      registerIpc();
      appReady = true;
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      flushDeepLinkIntents();
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
        flushDeepLinkIntents();
      });
    })
    .catch((error) => {
      dialog.showErrorBox(
        'Rirei could not start',
        error instanceof Error ? error.message : String(error),
      );
      app.quit();
    });

  app.on('before-quit', () => {
    appReady = false;
    readyRenderers.clear();
    for (const senderId of usageSubscriptions.keys())
      clearUsageSubscription(senderId);
    for (const notification of liveNotifications) notification.close();
    liveNotifications.clear();
    if (daemonReconnectTimer) {
      globalThis.clearTimeout(daemonReconnectTimer);
      daemonReconnectTimer = null;
    }
    terminalDaemon?.disconnect();
  });

  app.on('window-all-closed', () => app.quit());
}
