import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import net from 'node:net';
import { hostname, uptime } from 'node:os';
import path from 'node:path';
import {
  DAEMON_MAX_IO_BYTES,
  DAEMON_PROTOCOL_VERSION,
  DaemonFrameDecoder,
  encodeDaemonFrame,
  publicDaemonError,
  validCursor,
  validSize,
  validStartRequest,
  validThreadNotification,
  validThreadWatch,
  validTerminalId,
} from './terminal-daemon-protocol.mjs';
import {
  parseTerminalProtocolFrame,
  terminalControlFrame,
} from './terminal-control.mjs';
import { createTerminalHost } from './terminal-host.mjs';

const ACTIVE = new Set(['starting', 'running', 'waiting', 'stopping']);
const RUNTIME_ACTIVE = new Set(['starting', 'running']);
const FINAL = new Set(['completed', 'failed', 'cancelled', 'orphaned']);
const STRUCTURED_PROVIDERS = new Set(['claude', 'codex', 'opencode']);
const ATTENTION_KINDS = new Set(['permission', 'input', 'unknown']);
const ATTENTION_MARKERS = new Map([
  [
    'antigravity',
    [
      'Requesting your permission',
      'Permission to run command:',
      'Allow access to this file?',
      'requires permission to read, edit, and execute files here.',
    ],
  ],
]);
const MAX_TERMINALS = 4;
const OUTPUT_RING_BYTES = 2 * 1024 * 1024;
const OUTPUT_CHUNK_BYTES = DAEMON_MAX_IO_BYTES;
const AUTH_TIMEOUT_MS = 2_000;
const BRIDGE_REGISTRATION_TIMEOUT_MS = 60_000;

function isNamedPipePath(endpointPath) {
  return endpointPath.startsWith('\\\\.\\pipe\\');
}

function safeWrite(stream, data) {
  if (!stream?.writable || stream.destroyed) return false;
  try {
    stream.write(data, (error) => {
      if (error && !stream.destroyed) stream.destroy();
    });
    return true;
  } catch {
    return false;
  }
}

function writeStream(stream, data) {
  return new Promise((resolve, reject) => {
    if (!stream?.writable || stream.destroyed) {
      reject(new Error('Stream is unavailable.'));
      return;
    }
    try {
      stream.write(data, (error) => (error ? reject(error) : resolve()));
    } catch (error) {
      reject(error);
    }
  });
}

function currentBootId(now = Date.now()) {
  return `${hostname()}:${Math.round((now - uptime() * 1000) / 60_000)}`;
}

function lifecycleState(terminal) {
  if (terminal.status === 'running') return 'working';
  if (terminal.status === 'waiting')
    return terminal.attentionKind === 'permission'
      ? 'needs_permission'
      : 'waiting_for_input';
  return terminal.status;
}

function runtimeMilliseconds(terminal) {
  const active = RUNTIME_ACTIVE.has(terminal.status)
    ? Math.max(0, terminal.runtimeClock() - terminal.runtimeStartedAt)
    : 0;
  return terminal.activeRuntimeMs + active;
}

function publicTerminal(terminal) {
  return {
    id: terminal.id,
    provider: terminal.provider,
    workspaceId: terminal.workspaceId,
    branchLabel: terminal.branchLabel,
    project: terminal.project,
    projectLabel: path.basename(terminal.project),
    status: terminal.status,
    lifecycleState: lifecycleState(terminal),
    attentionKind: terminal.attentionKind,
    activeRuntimeSeconds: runtimeMilliseconds(terminal) / 1000,
    runtimeSequence: terminal.sequence,
    hidden: terminal.hidden,
    createdAt: terminal.createdAt,
    lastActivityAt: terminal.lastActivityAt,
    sequence: terminal.sequence,
    outputSequence: terminal.nextCursor,
    oldestCursor: terminal.oldestCursor,
    nextCursor: terminal.nextCursor,
    dimensions: { cols: terminal.cols, rows: terminal.rows },
    bridge: terminal.bridge,
    bridgeError: terminal.bridgeError,
    exitCode: terminal.exit?.code ?? null,
    signal: terminal.exit?.signal ?? null,
    error: terminal.exit?.error ?? null,
    providerResult: terminal.exit?.providerResult,
    bridgeStatus: terminal.exit?.bridgeStatus,
    cleanupPending: terminal.stateSyncPending,
  };
}

function appendOutput(terminal, data) {
  if (!data || data.length === 0) return;
  const outputStart = terminal.nextCursor;
  terminal.nextCursor += data.length;

  if (data.length >= OUTPUT_RING_BYTES) {
    const retained = Buffer.allocUnsafe(OUTPUT_RING_BYTES);
    data.copy(retained, 0, data.length - OUTPUT_RING_BYTES);
    terminal.outputChunks = [
      {
        cursor: terminal.nextCursor - OUTPUT_RING_BYTES,
        data: retained,
        start: 0,
        end: retained.length,
      },
    ];
    terminal.outputBytes = retained.length;
    terminal.oldestCursor = terminal.nextCursor - retained.length;
    terminal.lastActivityAt = new Date().toISOString();
    return;
  }

  let sourceOffset = 0;
  while (sourceOffset < data.length) {
    let chunk = terminal.outputChunks.at(-1);
    if (!chunk || chunk.end === chunk.data.length) {
      chunk = {
        cursor: outputStart + sourceOffset,
        data: Buffer.allocUnsafe(OUTPUT_CHUNK_BYTES),
        start: 0,
        end: 0,
      };
      terminal.outputChunks.push(chunk);
    }
    const copied = Math.min(
      chunk.data.length - chunk.end,
      data.length - sourceOffset,
    );
    data.copy(chunk.data, chunk.end, sourceOffset, sourceOffset + copied);
    chunk.end += copied;
    sourceOffset += copied;
  }
  terminal.outputBytes += data.length;

  while (
    terminal.outputBytes > OUTPUT_RING_BYTES &&
    terminal.outputChunks.length > 0
  ) {
    const excess = terminal.outputBytes - OUTPUT_RING_BYTES;
    const first = terminal.outputChunks[0];
    const firstLength = first.end - first.start;
    if (firstLength <= excess) {
      terminal.outputBytes -= firstLength;
      terminal.oldestCursor = first.cursor + firstLength;
      terminal.outputChunks.shift();
    } else {
      first.start += excess;
      first.cursor += excess;
      terminal.outputBytes -= excess;
      terminal.oldestCursor = first.cursor;
      break;
    }
  }
  terminal.lastActivityAt = new Date().toISOString();
}

function outputAttentionKind(terminal, buffer) {
  if (terminal.structuredLifecycle) return null;
  const bell = buffer.includes(0x07);
  const markers = ATTENTION_MARKERS.get(terminal.provider);
  if (!markers) return bell ? 'input' : null;
  /* eslint-disable no-control-regex -- Terminal controls must be stripped before marker matching. */
  const text = buffer
    .toString('utf8')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  /* eslint-enable no-control-regex */
  terminal.attentionScan = `${terminal.attentionScan}${text}`.slice(-4096);
  if (markers.some((marker) => terminal.attentionScan.includes(marker))) {
    terminal.attentionScan = '';
    return 'permission';
  }
  if (!bell) return null;
  const possiblePermissionMarker = markers.some((marker) => {
    const limit = Math.min(marker.length - 1, terminal.attentionScan.length);
    for (let length = limit; length > 0; length -= 1) {
      if (terminal.attentionScan.endsWith(marker.slice(0, length))) return true;
    }
    return false;
  });
  return possiblePermissionMarker ? null : 'input';
}

function outputSlice(terminal, cursor) {
  if (!validCursor(cursor))
    throw Object.assign(new Error('Invalid output cursor.'), {
      daemonCode: 'invalid_cursor',
    });
  if (cursor > terminal.nextCursor)
    throw Object.assign(new Error('Output cursor is ahead of the terminal.'), {
      daemonCode: 'cursor_ahead',
    });
  const startCursor = Math.max(cursor, terminal.oldestCursor);
  const targetEnd = Math.min(
    terminal.nextCursor,
    startCursor + DAEMON_MAX_IO_BYTES,
  );
  const result = Buffer.allocUnsafe(targetEnd - startCursor);
  let collected = 0;
  for (const chunk of terminal.outputChunks) {
    const chunkLength = chunk.end - chunk.start;
    const chunkEnd = chunk.cursor + chunkLength;
    if (chunkEnd <= startCursor) continue;
    if (chunk.cursor >= targetEnd) break;
    const offset = Math.max(0, startCursor - chunk.cursor);
    const take = Math.min(
      chunkLength - offset,
      targetEnd - (chunk.cursor + offset),
    );
    if (take > 0) {
      chunk.data.copy(
        result,
        collected,
        chunk.start + offset,
        chunk.start + offset + take,
      );
      collected += take;
    }
  }
  const sliceBuffer =
    collected === result.length ? result : result.subarray(0, collected);
  return {
    requestedCursor: cursor,
    oldestCursor: terminal.oldestCursor,
    startCursor,
    endCursor: startCursor + sliceBuffer.length,
    nextCursor: terminal.nextCursor,
    truncated: cursor < terminal.oldestCursor,
    data: sliceBuffer.toString('base64'),
    terminal: publicTerminal(terminal),
  };
}

function descriptorTokenMatches(expected, actual) {
  if (typeof actual !== 'string') return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function writeDescriptor(file, descriptor) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(file), 0o700);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(descriptor, null, 2)}\n`, {
      mode: 0o600,
    });
    await chmod(temporary, 0o600);
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function prepareSocket(socketPath) {
  if (isNamedPipePath(socketPath)) {
    const live = await new Promise((resolve) => {
      const socket = net.createConnection(socketPath);
      const timer = globalThis.setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, 200);
      socket.once('connect', () => {
        globalThis.clearTimeout(timer);
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        globalThis.clearTimeout(timer);
        resolve(false);
      });
    });
    if (live) throw new Error('A terminal daemon is already active.');
    return;
  }
  await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(socketPath), 0o700).catch(() => undefined);
  try {
    const details = await lstat(socketPath);
    if (!details.isSocket())
      throw new Error('Refusing to replace a non-socket daemon path.');
    const live = await new Promise((resolve) => {
      const socket = net.createConnection(socketPath);
      const timer = globalThis.setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, 200);
      socket.once('connect', () => {
        globalThis.clearTimeout(timer);
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        globalThis.clearTimeout(timer);
        resolve(false);
      });
    });
    if (live) throw new Error('A terminal daemon is already active.');
    await rm(socketPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export async function runTerminalDaemon(options) {
  process.umask(0o077);
  delete process.env.ELECTRON_RUN_AS_NODE;
  const daemonId = randomUUID();
  const daemonBootId = currentBootId();
  const token = randomBytes(32).toString('base64url');
  const terminals = new Map();
  const startingClaims = new Set();
  const terminalStartups = new Set();
  const connections = new Set();
  let closing = false;
  await prepareSocket(options.socketPath);

  const publish = (event, audience = () => true) => {
    const frame = encodeDaemonFrame({ type: 'event', ...event });
    for (const connection of connections)
      if (
        connection.authenticated &&
        audience(connection) &&
        !safeWrite(connection.socket, frame)
      )
        connection.socket.destroy();
  };

  const PRIORITY_ORDER = {
    final: 3,
    transition: 2,
    heartbeat: 1,
  };

  const terminalSyncQueues = new Map();

  const processNextSync = async (terminal, queue) => {
    if (queue.running || !queue.pending) return;
    queue.running = true;
    const task = queue.pending;
    queue.pending = null;
    let succeeded = false;

    try {
      const snapshot = publicTerminal(terminal);
      await options.updateProviderStatus(terminal.project, terminal.id, {
        status: snapshot.status,
        lifecycleState: snapshot.lifecycleState,
        attentionKind: snapshot.attentionKind,
        activeRuntimeSeconds: snapshot.activeRuntimeSeconds,
        runtimeSequence: snapshot.runtimeSequence,
        daemon: {
          instanceId: daemonId,
          pid: process.pid,
          bootId: daemonBootId,
        },
        exitCode: snapshot.exitCode,
        providerResult: snapshot.providerResult,
      });
      task.resolve();
      succeeded = true;
    } catch (err) {
      task.reject(err);
    } finally {
      queue.running = false;
      if (
        succeeded &&
        task.priority === 'final' &&
        queue.pending?.priority === 'heartbeat'
      ) {
        queue.pending.resolve();
        queue.pending = null;
      }
      if (queue.pending) {
        void processNextSync(terminal, queue);
      } else if (terminal.finalized) {
        terminalSyncQueues.delete(terminal.id);
      }
    }
  };

  const syncTerminal = (terminal, priority = 'transition') => {
    if (terminal.kind !== 'agent' || !options.updateProviderStatus)
      return Promise.resolve();

    let queue = terminalSyncQueues.get(terminal.id);
    if (!queue) {
      queue = {
        running: false,
        pending: null,
      };
      terminalSyncQueues.set(terminal.id, queue);
    }

    const weight = PRIORITY_ORDER[priority] ?? 1;
    if (queue.pending) {
      if (weight > queue.pending.weight) {
        queue.pending.priority = priority;
        queue.pending.weight = weight;
      }
      return queue.pending.promise;
    }

    const pending = {
      priority,
      weight,
      promise: null,
      resolve: null,
      reject: null,
    };
    pending.promise = new Promise((resolve, reject) => {
      pending.resolve = resolve;
      pending.reject = reject;
    });
    queue.pending = pending;
    void processNextSync(terminal, queue);
    return pending.promise;
  };

  const transitionTerminal = (
    terminal,
    status,
    attentionKind = null,
    { publishEvent = true, syncState = true } = {},
  ) => {
    const normalizedAttention =
      status === 'waiting' && ATTENTION_KINDS.has(attentionKind)
        ? attentionKind
        : null;
    if (
      terminal.status === status &&
      terminal.attentionKind === normalizedAttention
    )
      return false;
    const now = terminal.runtimeClock();
    const wasActive = RUNTIME_ACTIVE.has(terminal.status);
    const willBeActive = RUNTIME_ACTIVE.has(status);
    if (wasActive && !willBeActive) {
      terminal.activeRuntimeMs += Math.max(0, now - terminal.runtimeStartedAt);
      terminal.runtimeStartedAt = null;
    } else if (!wasActive && willBeActive) {
      terminal.runtimeStartedAt = now;
    }
    terminal.status = status;
    terminal.attentionKind = normalizedAttention;
    terminal.sequence += 1;
    terminal.lastActivityAt = new Date().toISOString();
    if (publishEvent)
      publish({ event: 'status', terminal: publicTerminal(terminal) });
    if (syncState)
      void syncTerminal(terminal, 'transition').catch(() => undefined);
    return true;
  };

  const requireTerminal = (terminalId) => {
    if (!validTerminalId(terminalId) || !terminals.has(terminalId))
      throw Object.assign(new Error('Terminal not found.'), {
        daemonCode: 'not_found',
      });
    return terminals.get(terminalId);
  };

  const finalize = async (terminal, code, signal, error) => {
    if (terminal.finalized) return;
    terminal.finalized = true;
    for (const timer of terminal.stopTimers) globalThis.clearTimeout(timer);
    terminal.stopTimers = [];
    let providerResult;
    if (terminal.kind === 'agent') {
      try {
        const result = await options.readProviderResult(
          terminal.project,
          terminal.id,
        );
        providerResult = result ?? undefined;
      } catch {
        providerResult = undefined;
      }
    }
    const wasStopping = terminal.status === 'stopping';
    const bridgeStatus = wasStopping
      ? 'cancelled'
      : error || signal || (code !== 0 && code !== null)
        ? 'failed'
        : 'completed';
    const finalStatus = providerResult
      ? providerResult.reason === 'completed'
        ? 'completed'
        : ['user_cancelled', 'interrupted'].includes(providerResult.reason)
          ? 'cancelled'
          : 'failed'
      : bridgeStatus;
    transitionTerminal(terminal, finalStatus, null, {
      publishEvent: false,
      syncState: false,
    });
    terminal.exit = {
      code,
      signal,
      error: error ? 'Terminal bridge failed.' : null,
      bridgeStatus,
      providerResult,
    };
    terminal.child = null;
    if (terminal.controllerConnection) {
      terminal.controllerConnection.controlledTerminals.delete(terminal.id);
      terminal.controllerConnection = null;
    }
    terminal.stateSyncPending = terminal.kind === 'agent';
    if (terminal.stateSyncPending) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await syncTerminal(terminal, 'final');
          terminal.stateSyncPending = false;
          if (terminal.bridgeError === 'state_sync_failed')
            terminal.bridgeError = null;
          break;
        } catch {
          if (attempt < 2)
            await new Promise((resolve) =>
              globalThis.setTimeout(resolve, 50 * (attempt + 1)),
            );
        }
      }
      if (terminal.stateSyncPending) terminal.bridgeError = 'state_sync_failed';
    }
    publish({ event: 'exit', terminal: publicTerminal(terminal) });
  };

  const registerBridge = async (terminal) => {
    if (!options.registerBridge || terminal.bridgeRegistrationStarted) return;
    terminal.bridgeRegistrationStarted = true;
    const deadline = Date.now() + BRIDGE_REGISTRATION_TIMEOUT_MS;
    let retryMs = options.bridgeRegistrationRetryMs ?? 250;
    while (!terminal.finalized && Date.now() < deadline) {
      try {
        await options.registerBridge(
          terminal.project,
          terminal.id,
          terminal.bridge,
        );
        await syncTerminal(terminal, 'transition');
        return;
      } catch {
        await new Promise((resolve) =>
          globalThis.setTimeout(
            resolve,
            Math.min(retryMs, deadline - Date.now()),
          ),
        );
        retryMs = Math.min(retryMs * 2, 2_000);
      }
    }
    if (!terminal.finalized) {
      terminal.bridgeError = 'bridge_registration_failed';
      terminal.sequence += 1;
      publish({ event: 'status', terminal: publicTerminal(terminal) });
    }
  };

  const startTerminal = async (body) => {
    if (closing)
      throw Object.assign(new Error('Terminal daemon is shutting down.'), {
        daemonCode: 'shutting_down',
      });
    if (!validStartRequest(body))
      throw Object.assign(new Error('Invalid project.'), {
        daemonCode: 'invalid_start',
      });
    const workspaceId = body.workspaceId || 'default';
    const claimKey = JSON.stringify([body.project, workspaceId]);
    if (
      [...terminals.values()].filter((item) => ACTIVE.has(item.status)).length +
        startingClaims.size >=
      MAX_TERMINALS
    )
      throw Object.assign(new Error('Maximum active terminals reached.'), {
        daemonCode: 'capacity',
      });
    if (
      [...terminals.values()].some(
        (item) =>
          item.project === body.project &&
          item.workspaceId === workspaceId &&
          ACTIVE.has(item.status),
      ) ||
      startingClaims.has(claimKey)
    )
      throw Object.assign(new Error('This working tree is already claimed.'), {
        daemonCode: 'claimed',
      });
    startingClaims.add(claimKey);
    const id = randomUUID();
    const size = validSize(body.size);
    const terminal = {
      id,
      kind: body.kind === 'shell' ? 'shell' : 'agent',
      provider: body.kind === 'shell' ? 'shell' : body.agent,
      project: body.project,
      workspaceId,
      branchLabel: body.branchLabel || 'main',
      hidden: false,
      status: 'starting',
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      sequence: 0,
      cols: size.cols,
      rows: size.rows,
      outputChunks: [],
      outputBytes: 0,
      oldestCursor: 0,
      nextCursor: 0,
      controllerConnection: null,
      bridge: null,
      bridgeError: null,
      bridgeRegistrationStarted: false,
      finalized: false,
      stateSyncPending: false,
      exit: null,
      child: null,
      host: null,
      stopTimers: [],
      attentionScan: '',
      attentionKind: null,
      structuredLifecycle:
        body.kind !== 'shell' && STRUCTURED_PROVIDERS.has(body.agent),
      lifecycleToken: randomBytes(32).toString('base64url'),
      activeRuntimeMs: 0,
      runtimeStartedAt: performance.now(),
      runtimeClock: () => performance.now(),
    };
    let command;
    try {
      command = options.commandFor(body, id);
    } catch (error) {
      startingClaims.delete(claimKey);
      throw error;
    }
    const terminalEnv = {
      ...process.env,
      PATH: options.pathValue ?? process.env.PATH,
      RELAY_COLS: String(size.cols),
      RELAY_ROWS: String(size.rows),
      RELAY_SIGNAL_PROCESS_GROUP: body.kind === 'shell' ? '1' : '0',
      TERM: process.env.TERM ?? 'xterm-256color',
      RIREI_TERMINAL_ID: id,
      RIREI_LIFECYCLE_SOCKET: options.socketPath,
      RIREI_LIFECYCLE_TOKEN: terminal.lifecycleToken,
      ...(options.nodePath ? { RIREI_NODE_PATH: options.nodePath } : {}),
      ...(options.lifecycleHookPath
        ? { RIREI_LIFECYCLE_HOOK: options.lifecycleHookPath }
        : {}),
      ...(options.codexLifecycleWrapperPath
        ? {
            RIREI_CODEX_LIFECYCLE_WRAPPER: options.codexLifecycleWrapperPath,
          }
        : {}),
      ...(options.openCodeLifecycleWrapperPath
        ? {
            RIREI_OPENCODE_LIFECYCLE_WRAPPER:
              options.openCodeLifecycleWrapperPath,
          }
        : {}),
    };
    if (options.forcePythonBridge && options.bridgePath) {
      let child;
      try {
        child = spawn('/usr/bin/python3', [options.bridgePath, ...command], {
          cwd: body.project,
          env: terminalEnv,
          stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (error) {
        startingClaims.delete(claimKey);
        throw error;
      }
      terminal.child = child;
      terminals.set(id, terminal);
      startingClaims.delete(claimKey);
      publish({ event: 'created', terminal: publicTerminal(terminal) });
      child.stdout.on('data', (chunk) => {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (terminal.status === 'starting')
          transitionTerminal(terminal, 'running');
        appendOutput(terminal, data);
        const attentionKind =
          terminal.kind === 'agent' && terminal.status === 'running'
            ? outputAttentionKind(terminal, data)
            : null;
        if (attentionKind)
          transitionTerminal(terminal, 'waiting', attentionKind);
        publish({
          event: 'output_available',
          terminalId: id,
          nextCursor: terminal.nextCursor,
        });
      });
      let diagnosticBytes = 0;
      child.stderr.on('data', (data) => {
        diagnosticBytes += data.length;
        if (diagnosticBytes <= 4096) terminal.bridgeError = 'bridge_diagnostic';
      });
      let bridgeBuffer = '';
      child.stdio[4].on('data', (data) => {
        bridgeBuffer += data.toString('utf8');
        if (bridgeBuffer.length > 64 * 1024) bridgeBuffer = '';
        while (bridgeBuffer.includes('\n')) {
          const offset = bridgeBuffer.indexOf('\n');
          const line = bridgeBuffer.slice(0, offset);
          bridgeBuffer = bridgeBuffer.slice(offset + 1);
          const frame = parseTerminalProtocolFrame(line);
          if (!frame) continue;
          if (frame.type === 'ready') {
            terminal.bridge = {
              instanceId: frame.bridgeId,
              pid: frame.bridgePid,
              childPid: frame.childPid,
              protocolVersion: frame.version,
            };
            if (terminal.status === 'starting')
              transitionTerminal(terminal, 'running');
          } else if (frame.type === 'error') terminal.bridgeError = frame.code;
          terminal.lastActivityAt = new Date().toISOString();
          terminal.sequence += 1;
          publish({ event: 'status', terminal: publicTerminal(terminal) });
          if (frame.type === 'ready') void registerBridge(terminal);
        }
      });
      child.once('error', () => void finalize(terminal, null, null, true));
      child.once(
        'close',
        (code, signal) => void finalize(terminal, code, signal, false),
      );
      return publicTerminal(terminal);
    }

    const [executable, ...args] = command;
    let host;
    try {
      host = await createTerminalHost(executable, args, {
        cwd: body.project,
        env: terminalEnv,
        cols: size.cols,
        rows: size.rows,
        parentGuardNodePath: options.nodePath,
      });
    } catch (error) {
      startingClaims.delete(claimKey);
      throw error;
    }
    terminal.host = host;
    terminal.bridge = {
      instanceId: id,
      pid: host.pid,
      childPid: host.pid,
      protocolVersion: 1,
    };
    terminals.set(id, terminal);
    startingClaims.delete(claimKey);
    publish({ event: 'created', terminal: publicTerminal(terminal) });
    transitionTerminal(terminal, 'running');
    void registerBridge(terminal);

    host.onData((chunk) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (terminal.status === 'starting')
        transitionTerminal(terminal, 'running');
      appendOutput(terminal, data);
      const attentionKind =
        terminal.kind === 'agent' && terminal.status === 'running'
          ? outputAttentionKind(terminal, data)
          : null;
      if (attentionKind) transitionTerminal(terminal, 'waiting', attentionKind);
      publish({
        event: 'output_available',
        terminalId: id,
        nextCursor: terminal.nextCursor,
      });
    });

    host.onExit((result) => {
      void finalize(
        terminal,
        result.exitCode,
        result.signal,
        Boolean(result.error),
      );
    });

    return publicTerminal(terminal);
  };

  const start = (body) => {
    const startup = startTerminal(body);
    terminalStartups.add(startup);
    void startup.then(
      () => terminalStartups.delete(startup),
      () => terminalStartups.delete(startup),
    );
    return startup;
  };

  const stop = (terminal) => {
    if ((!terminal.child && !terminal.host) || terminal.finalized)
      return publicTerminal(terminal);
    if (terminal.status === 'stopping') return publicTerminal(terminal);
    transitionTerminal(terminal, 'stopping');
    if (terminal.host) {
      void terminal.host.interrupt('user_stop');
      terminal.stopTimers = [
        globalThis.setTimeout(() => {
          if (!terminal.finalized) void terminal.host.terminate();
        }, options.stopTerminateMs ?? 2000),
        globalThis.setTimeout(() => {
          if (!terminal.finalized) void terminal.host.killTree();
        }, options.stopKillMs ?? 4000),
      ];
      return publicTerminal(terminal);
    }
    safeWrite(
      terminal.child.stdio[3],
      terminalControlFrame('interrupt', { intent: 'user_stop' }),
    );
    terminal.stopTimers = [
      globalThis.setTimeout(() => {
        if (!terminal.finalized)
          safeWrite(
            terminal.child?.stdio[3],
            terminalControlFrame('terminate'),
          );
      }, options.stopTerminateMs ?? 2000),
      globalThis.setTimeout(() => {
        if (!terminal.finalized)
          safeWrite(terminal.child?.stdio[3], terminalControlFrame('kill'));
      }, options.stopKillMs ?? 4000),
    ];
    return publicTerminal(terminal);
  };

  const dispatch = async (connection, op, body = {}) => {
    if (op === 'list') return [...terminals.values()].map(publicTerminal);
    if (op === 'start') return start(body);
    if (op === 'stop_all') {
      const active = [...terminals.values()].filter((terminal) =>
        ACTIVE.has(terminal.status),
      );
      return {
        count: active.length,
        terminals: active.map(stop),
      };
    }
    if (op === 'watch_threads') {
      if (!validThreadWatch(body))
        throw Object.assign(new Error('Invalid Threads audience.'), {
          daemonCode: 'invalid_threads_audience',
        });
      if (body.enabled) connection.threadProjects.add(body.projectRoot);
      else connection.threadProjects.delete(body.projectRoot);
      return { ok: true };
    }
    if (op === 'notify_threads') {
      if (!validThreadNotification(body))
        throw Object.assign(new Error('Invalid Threads notification.'), {
          daemonCode: 'invalid_threads_notification',
        });
      publish(
        {
          event: 'threads_changed',
          ...body,
        },
        (item) => item.threadProjects.has(body.projectRoot),
      );
      return { ok: true };
    }
    const terminal = requireTerminal(body.terminalId);
    if (op === 'inspect') return publicTerminal(terminal);
    if (op === 'attach') {
      const replay = outputSlice(terminal, body.cursor ?? 0);
      connection.attachments.add(terminal.id);
      return replay;
    }
    if (op === 'detach') {
      if (terminal.controllerConnection === connection) {
        terminal.controllerConnection = null;
        connection.controlledTerminals.delete(terminal.id);
      }
      connection.attachments.delete(terminal.id);
      return { ok: true };
    }
    if (op === 'acquire_control') {
      if (terminal.finalized)
        throw Object.assign(new Error('Terminal is no longer running.'), {
          daemonCode: 'not_running',
        });
      const takeover = body.takeover === true;
      if (
        terminal.controllerConnection &&
        terminal.controllerConnection !== connection
      ) {
        if (!takeover) {
          throw Object.assign(
            new Error('Terminal control is already held by another client.'),
            {
              daemonCode: 'control_busy',
            },
          );
        }
        const displaced = terminal.controllerConnection;
        displaced.controlledTerminals.delete(terminal.id);
        terminal.controllerConnection = connection;
        connection.controlledTerminals.add(terminal.id);
        safeWrite(
          displaced.socket,
          encodeDaemonFrame({
            type: 'event',
            event: 'control_revoked',
            terminalId: terminal.id,
            reason: 'takeover',
          }),
        );
        return { ok: true, terminalId: terminal.id };
      }
      terminal.controllerConnection = connection;
      connection.controlledTerminals.add(terminal.id);
      return { ok: true, terminalId: terminal.id };
    }
    if (op === 'release_control') {
      if (terminal.controllerConnection === connection) {
        terminal.controllerConnection = null;
        connection.controlledTerminals.delete(terminal.id);
      }
      return { ok: true, terminalId: terminal.id };
    }
    if (op === 'write') {
      if (!connection.attachments.has(terminal.id))
        throw Object.assign(new Error('Terminal is not attached.'), {
          daemonCode: 'not_attached',
        });
      if (terminal.controllerConnection !== connection)
        throw Object.assign(
          new Error('Terminal control is required to write.'),
          {
            daemonCode: 'not_controller',
          },
        );
      if (
        typeof body.data !== 'string' ||
        body.data.length > Math.ceil(DAEMON_MAX_IO_BYTES / 3) * 4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          body.data,
        )
      )
        throw Object.assign(new Error('Invalid terminal input.'), {
          daemonCode: 'invalid_input',
        });
      const data = Buffer.from(body.data, 'base64');
      if (data.length > DAEMON_MAX_IO_BYTES)
        throw Object.assign(new Error('Input exceeds the size limit.'), {
          daemonCode: 'input_too_large',
        });
      try {
        if (terminal.host) {
          await terminal.host.write(data);
        } else {
          await writeStream(terminal.child?.stdin, data);
        }
      } catch {
        throw Object.assign(new Error('Terminal input is unavailable.'), {
          daemonCode: 'not_running',
        });
      }
      if (terminal.status === 'waiting' && !terminal.structuredLifecycle) {
        transitionTerminal(terminal, 'running');
      }
      return { ok: true };
    }
    if (op === 'resize') {
      if (terminal.controllerConnection !== connection)
        throw Object.assign(
          new Error('Terminal control is required to resize.'),
          {
            daemonCode: 'not_controller',
          },
        );
      const size = validSize(body, {
        cols: terminal.cols,
        rows: terminal.rows,
      });
      terminal.cols = size.cols;
      terminal.rows = size.rows;
      terminal.sequence += 1;
      terminal.lastActivityAt = new Date().toISOString();
      if (terminal.host) {
        terminal.host.resize(size.cols, size.rows);
      } else {
        safeWrite(
          terminal.child?.stdio[3],
          terminalControlFrame('resize', size),
        );
      }
      const published = publicTerminal(terminal);
      publish({ event: 'resized', terminal: published });
      return published;
    }
    if (op === 'set_waiting') {
      if (terminal.finalized)
        throw Object.assign(new Error('Terminal is no longer running.'), {
          daemonCode: 'not_running',
        });
      if (terminal.status === 'stopping' || terminal.structuredLifecycle)
        return publicTerminal(terminal);
      transitionTerminal(
        terminal,
        'waiting',
        ATTENTION_KINDS.has(body.attentionKind)
          ? body.attentionKind
          : 'unknown',
      );
      return publicTerminal(terminal);
    }
    if (op === 'set_lifecycle') {
      if (terminal.finalized)
        throw Object.assign(new Error('Terminal is no longer running.'), {
          daemonCode: 'not_running',
        });
      if (terminal.status === 'stopping') return publicTerminal(terminal);
      if (body.lifecycleState === 'working')
        transitionTerminal(terminal, 'running');
      else if (body.lifecycleState === 'needs_permission')
        transitionTerminal(terminal, 'waiting', 'permission');
      else if (body.lifecycleState === 'waiting_for_input')
        transitionTerminal(terminal, 'waiting', 'input');
      else
        throw Object.assign(new Error('Invalid lifecycle state.'), {
          daemonCode: 'invalid_lifecycle',
        });
      return publicTerminal(terminal);
    }
    if (op === 'interrupt') {
      if (terminal.host) {
        await terminal.host.interrupt('user_interrupt');
      } else if (
        !safeWrite(
          terminal.child?.stdio[3],
          terminalControlFrame('interrupt', { intent: 'user_interrupt' }),
        )
      ) {
        throw Object.assign(new Error('Terminal interrupt is unavailable.'), {
          daemonCode: 'not_running',
        });
      }
      terminal.sequence += 1;
      terminal.lastActivityAt = new Date().toISOString();
      const published = publicTerminal(terminal);
      publish({ event: 'interrupted', terminal: published });
      return published;
    }
    if (op === 'stop') return stop(terminal);
    if (op === 'set_hidden') {
      terminal.hidden = body.hidden === true;
      terminal.sequence += 1;
      terminal.lastActivityAt = new Date().toISOString();
      const published = publicTerminal(terminal);
      publish({ event: 'hidden', terminal: published });
      return published;
    }
    if (op === 'forget') {
      if (!FINAL.has(terminal.status))
        throw Object.assign(
          new Error('Running terminals cannot be forgotten.'),
          {
            daemonCode: 'still_running',
          },
        );
      if (terminal.controllerConnection) {
        terminal.controllerConnection.controlledTerminals.delete(terminal.id);
        terminal.controllerConnection = null;
      }
      terminals.delete(terminal.id);
      const syncQueue = terminalSyncQueues.get(terminal.id);
      if (syncQueue) {
        terminalSyncQueues.delete(terminal.id);
        syncQueue.pending?.reject(new Error('Terminal was forgotten.'));
        syncQueue.pending = null;
      }
      for (const item of connections) {
        item.attachments.delete(terminal.id);
        item.controlledTerminals.delete(terminal.id);
      }
      publish({ event: 'forgotten', terminalId: terminal.id });
      return { ok: true };
    }
    throw Object.assign(new Error('Unsupported daemon operation.'), {
      daemonCode: 'unsupported_operation',
    });
  };

  const server = net.createServer((socket) => {
    const connection = {
      socket,
      authenticated: false,
      restrictedTerminalId: null,
      attachments: new Set(),
      controlledTerminals: new Set(),
      threadProjects: new Set(),
      decoder: new DaemonFrameDecoder(),
    };
    connections.add(connection);
    const timer = globalThis.setTimeout(
      () => socket.destroy(),
      AUTH_TIMEOUT_MS,
    );
    socket.on('data', (chunk) => {
      let frames;
      try {
        frames = connection.decoder.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const frame of frames) {
        if (!connection.authenticated) {
          const lifecycleTerminal =
            frame.type === 'lifecycle_hello' &&
            validTerminalId(frame.terminalId)
              ? terminals.get(frame.terminalId)
              : undefined;
          const lifecycleAuthenticated = Boolean(
            lifecycleTerminal &&
            descriptorTokenMatches(
              lifecycleTerminal.lifecycleToken,
              frame.token,
            ),
          );
          const clientAuthenticated =
            frame.type === 'hello' &&
            descriptorTokenMatches(token, frame.token);
          if (!clientAuthenticated && !lifecycleAuthenticated) {
            socket.destroy();
            return;
          }
          connection.authenticated = true;
          connection.restrictedTerminalId = lifecycleAuthenticated
            ? frame.terminalId
            : null;
          globalThis.clearTimeout(timer);
          if (
            !safeWrite(
              socket,
              encodeDaemonFrame({
                type: 'welcome',
                daemonId,
                pid: process.pid,
                bootId: daemonBootId,
                capabilities: lifecycleAuthenticated
                  ? ['set_lifecycle']
                  : [
                      'start',
                      'list',
                      'inspect',
                      'attach',
                      'detach',
                      'acquire_control',
                      'release_control',
                      'write',
                      'resize',
                      'set_waiting',
                      'set_lifecycle',
                      'interrupt',
                      'stop',
                      'stop_all',
                      'set_hidden',
                      'forget',
                      'watch_threads',
                      'notify_threads',
                    ],
              }),
            )
          )
            socket.destroy();
          continue;
        }
        if (frame.type !== 'request' || typeof frame.id !== 'string') {
          socket.destroy();
          return;
        }
        if (
          connection.restrictedTerminalId &&
          (frame.op !== 'set_lifecycle' ||
            frame.body?.terminalId !== connection.restrictedTerminalId)
        ) {
          socket.destroy();
          return;
        }
        void dispatch(connection, frame.op, frame.body).then(
          (body) => {
            if (
              !safeWrite(
                socket,
                encodeDaemonFrame({
                  type: 'response',
                  id: frame.id,
                  ok: true,
                  body,
                }),
              )
            )
              socket.destroy();
          },
          (error) => {
            if (
              !safeWrite(
                socket,
                encodeDaemonFrame({
                  type: 'response',
                  id: frame.id,
                  ok: false,
                  error: publicDaemonError(
                    error?.daemonCode ?? 'operation_failed',
                    error?.message ?? 'Daemon operation failed.',
                  ),
                }),
              )
            )
              socket.destroy();
          },
        );
      }
    });
    socket.on('close', () => {
      globalThis.clearTimeout(timer);
      connections.delete(connection);
      for (const terminalId of connection.controlledTerminals) {
        const terminal = terminals.get(terminalId);
        if (terminal && terminal.controllerConnection === connection) {
          terminal.controllerConnection = null;
        }
      }
      connection.controlledTerminals.clear();
      connection.attachments.clear();
    });
    socket.on('error', () => undefined);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.socketPath, resolve);
  });
  try {
    if (!isNamedPipePath(options.socketPath))
      await chmod(options.socketPath, 0o600);
    await writeDescriptor(options.descriptorPath, {
      schemaVersion: 1,
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      daemonId,
      pid: process.pid,
      bootId: daemonBootId,
      socketPath: options.socketPath,
      reconnectToken: token,
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    await new Promise((resolve) => server.close(resolve));
    if (!isNamedPipePath(options.socketPath))
      await rm(options.socketPath, { force: true });
    throw error;
  }

  const heartbeatTimer = globalThis.setInterval(() => {
    for (const terminal of terminals.values())
      if (ACTIVE.has(terminal.status)) {
        void syncTerminal(terminal, 'heartbeat').catch(() => undefined);
      } else if (terminal.stateSyncPending) {
        void syncTerminal(terminal, 'heartbeat').then(
          () => {
            terminal.stateSyncPending = false;
            if (terminal.bridgeError === 'state_sync_failed')
              terminal.bridgeError = null;
            terminal.sequence += 1;
            publish({ event: 'status', terminal: publicTerminal(terminal) });
          },
          () => undefined,
        );
      }
  }, 5_000);
  heartbeatTimer.unref();

  let closePromise;
  return {
    daemonId,
    daemonBootId,
    token,
    server,
    terminals,
    close: async ({ stopActive = true } = {}) => {
      if (!closePromise)
        closePromise = (async () => {
          closing = true;
          globalThis.clearInterval(heartbeatTimer);
          for (const syncQueue of terminalSyncQueues.values()) {
            syncQueue.pending?.reject(new Error('Daemon is closing.'));
            syncQueue.pending = null;
          }
          terminalSyncQueues.clear();
          await Promise.allSettled([...terminalStartups]);
          if (stopActive)
            for (const terminal of terminals.values())
              if (ACTIVE.has(terminal.status)) stop(terminal);
          if (stopActive) {
            const deadline = Date.now() + (options.shutdownTimeoutMs ?? 5500);
            while (
              [...terminals.values()].some((terminal) =>
                ACTIVE.has(terminal.status),
              ) &&
              Date.now() < deadline
            )
              await new Promise((resolve) =>
                globalThis.setTimeout(resolve, 25),
              );
            for (const terminal of terminals.values())
              if (ACTIVE.has(terminal.status) && terminal.host)
                await terminal.host.killTree().catch(() => undefined);
            const forcedDeadline = Date.now() + 500;
            while (
              [...terminals.values()].some((terminal) =>
                ACTIVE.has(terminal.status),
              ) &&
              Date.now() < forcedDeadline
            )
              await new Promise((resolve) =>
                globalThis.setTimeout(resolve, 25),
              );
          }
          for (const connection of connections) connection.socket.destroy();
          connections.clear();
          await new Promise((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
          if (!isNamedPipePath(options.socketPath))
            await rm(options.socketPath, { force: true });
          try {
            const descriptor = JSON.parse(
              await readFile(options.descriptorPath, 'utf8'),
            );
            if (descriptor.daemonId === daemonId)
              await rm(options.descriptorPath, { force: true });
          } catch {
            // A replacement daemon owns the descriptor or it is already gone.
          }
        })();
      await closePromise;
    },
  };
}

export function daemonSocketPath(runtimeRoot) {
  const hash = createHash('sha256')
    .update(runtimeRoot)
    .digest('hex')
    .slice(0, 16);
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\rirei-${hash}-pty-v1`;
  }
  return path.join(runtimeRoot, `pty-${hash}.sock`);
}
