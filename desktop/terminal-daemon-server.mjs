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

function safeString(value, max = 255) {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
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
  };
}

function appendOutput(terminal, chunk) {
  const data = Buffer.from(chunk);
  terminal.output = Buffer.concat([terminal.output, data]);
  terminal.nextCursor += data.length;
  if (terminal.output.length > OUTPUT_RING_BYTES) {
    const remove = terminal.output.length - OUTPUT_RING_BYTES;
    terminal.output = terminal.output.subarray(remove);
    terminal.oldestCursor += remove;
  }
  terminal.lastActivityAt = new Date().toISOString();
}

function outputAttentionKind(terminal, chunk) {
  if (terminal.structuredLifecycle) return null;
  const bell = Buffer.from(chunk).includes(0x07);
  const markers = ATTENTION_MARKERS.get(terminal.provider);
  if (!markers) return bell ? 'input' : null;
  /* eslint-disable no-control-regex -- Terminal controls must be stripped before marker matching. */
  const text = Buffer.from(chunk)
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
  return bell ? 'input' : null;
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
  const offset = startCursor - terminal.oldestCursor;
  const data = terminal.output.subarray(offset, offset + DAEMON_MAX_IO_BYTES);
  return {
    requestedCursor: cursor,
    oldestCursor: terminal.oldestCursor,
    startCursor,
    endCursor: startCursor + data.length,
    nextCursor: terminal.nextCursor,
    truncated: cursor < terminal.oldestCursor,
    data: data.toString('base64'),
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
  const connections = new Set();
  let closing = false;
  await prepareSocket(options.socketPath);

  const publish = (event) => {
    const frame = encodeDaemonFrame({ type: 'event', ...event });
    for (const connection of connections)
      if (connection.authenticated && !safeWrite(connection.socket, frame))
        connection.socket.destroy();
  };

  const syncTerminal = (terminal) => {
    if (terminal.kind !== 'agent' || !options.updateProviderStatus)
      return Promise.resolve();
    const snapshot = publicTerminal(terminal);
    return options.updateProviderStatus(terminal.project, terminal.id, {
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
    });
  };

  const transitionTerminal = (
    terminal,
    status,
    attentionKind = null,
    { publishEvent = true } = {},
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
    void syncTerminal(terminal).catch(() => undefined);
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
    transitionTerminal(terminal, finalStatus, null, { publishEvent: false });
    terminal.exit = {
      code,
      signal,
      error: error ? 'Terminal bridge failed.' : null,
      bridgeStatus,
      providerResult,
    };
    terminal.child = null;
    publish({ event: 'exit', terminal: publicTerminal(terminal) });
    await syncTerminal(terminal).catch(() => undefined);
  };

  const registerBridge = async (terminal) => {
    if (!options.registerBridge || terminal.bridgeRegistrationStarted) return;
    terminal.bridgeRegistrationStarted = true;
    const deadline = Date.now() + BRIDGE_REGISTRATION_TIMEOUT_MS;
    while (!terminal.finalized && Date.now() < deadline) {
      try {
        await options.registerBridge(
          terminal.project,
          terminal.id,
          terminal.bridge,
        );
        await syncTerminal(terminal);
        return;
      } catch {
        await new Promise((resolve) =>
          globalThis.setTimeout(
            resolve,
            options.bridgeRegistrationRetryMs ?? 250,
          ),
        );
      }
    }
    if (!terminal.finalized) {
      terminal.bridgeError = 'bridge_registration_failed';
      terminal.sequence += 1;
      publish({ event: 'status', terminal: publicTerminal(terminal) });
    }
  };

  const start = async (body) => {
    if (closing)
      throw Object.assign(new Error('Terminal daemon is shutting down.'), {
        daemonCode: 'shutting_down',
      });
    if (!body || !safeString(body.project, 4096))
      throw Object.assign(new Error('Invalid project.'), {
        daemonCode: 'invalid_start',
      });
    if (
      [...terminals.values()].filter((item) => ACTIVE.has(item.status))
        .length >= MAX_TERMINALS
    )
      throw Object.assign(new Error('Maximum active terminals reached.'), {
        daemonCode: 'capacity',
      });
    if (
      [...terminals.values()].some(
        (item) =>
          item.project === body.project &&
          item.workspaceId === body.workspaceId &&
          ACTIVE.has(item.status),
      )
    )
      throw Object.assign(new Error('This working tree is already claimed.'), {
        daemonCode: 'claimed',
      });
    const id = randomUUID();
    const size = validSize(body.size);
    const terminal = {
      id,
      kind: body.kind === 'shell' ? 'shell' : 'agent',
      provider: body.kind === 'shell' ? 'shell' : body.agent,
      project: body.project,
      workspaceId: body.workspaceId || 'default',
      branchLabel: body.branchLabel || 'main',
      hidden: false,
      status: 'starting',
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      sequence: 0,
      cols: size.cols,
      rows: size.rows,
      output: Buffer.alloc(0),
      oldestCursor: 0,
      nextCursor: 0,
      bridge: null,
      bridgeError: null,
      bridgeRegistrationStarted: false,
      finalized: false,
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
    const command = options.commandFor(body, id);
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
      const child = spawn(
        '/usr/bin/python3',
        [options.bridgePath, ...command],
        {
          cwd: body.project,
          env: terminalEnv,
          stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
        },
      );
      terminal.child = child;
      terminals.set(id, terminal);
      publish({ event: 'created', terminal: publicTerminal(terminal) });
      child.stdout.on('data', (data) => {
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
    const host = await createTerminalHost(executable, args, {
      cwd: body.project,
      env: terminalEnv,
      cols: size.cols,
      rows: size.rows,
      parentGuardNodePath: options.nodePath,
    });
    terminal.host = host;
    terminal.bridge = {
      instanceId: id,
      pid: host.pid,
      childPid: host.pid,
      protocolVersion: 1,
    };
    terminals.set(id, terminal);
    publish({ event: 'created', terminal: publicTerminal(terminal) });
    transitionTerminal(terminal, 'running');
    void registerBridge(terminal);

    host.onData((data) => {
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
    const terminal = requireTerminal(body.terminalId);
    if (op === 'inspect') return publicTerminal(terminal);
    if (op === 'attach') {
      const replay = outputSlice(terminal, body.cursor ?? 0);
      connection.attachments.add(terminal.id);
      return replay;
    }
    if (op === 'detach') {
      connection.attachments.delete(terminal.id);
      return { ok: true };
    }
    if (op === 'write') {
      if (!connection.attachments.has(terminal.id))
        throw Object.assign(new Error('Terminal is not attached.'), {
          daemonCode: 'not_attached',
        });
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
      terminals.delete(terminal.id);
      for (const item of connections) item.attachments.delete(terminal.id);
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
                      'write',
                      'resize',
                      'set_waiting',
                      'set_lifecycle',
                      'interrupt',
                      'stop',
                      'set_hidden',
                      'forget',
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
      if (ACTIVE.has(terminal.status))
        void syncTerminal(terminal).catch(() => undefined);
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
