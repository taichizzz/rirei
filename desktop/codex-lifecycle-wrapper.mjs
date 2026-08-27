import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dependencyUrl = import.meta.url.includes('.asar.unpacked/')
  ? import.meta.url.replace('.asar.unpacked/', '.asar/')
  : import.meta.url;
const spawn = createRequire(dependencyUrl)('cross-spawn');

const STARTUP_TIMEOUT_MS = 10_000;
export const CODEX_REMOTE_TOKEN_ENV = 'RIREI_CODEX_WS_TOKEN';
const ANSI_CSI = new RegExp(
  `${String.fromCharCode(0x1b)}\\[[0-?]*[ -/]*[@-~]`,
  'g',
);
const LISTENING =
  /^\s{2}listening on: (ws:\/\/127\.0\.0\.1:([1-9][0-9]{0,4}))\r?$/;

export function codexRemoteArgs(args, url) {
  const remote = [
    '--remote',
    url,
    '--remote-auth-token-env',
    CODEX_REMOTE_TOKEN_ENV,
  ];
  return args[0] === 'resume'
    ? ['resume', ...remote, ...args.slice(1)]
    : [...remote, ...args];
}

export function codexAppServerArgs(token) {
  const digest = createHash('sha256').update(token).digest('hex');
  return [
    'app-server',
    '--listen',
    'ws://127.0.0.1:0',
    '--ws-auth',
    'capability-token',
    '--ws-token-sha256',
    digest,
  ];
}

export function codexLifecycleState(message) {
  if (message?.method !== 'thread/status/changed') return null;
  const status = message.params?.status;
  const type = typeof status === 'string' ? status : status?.type;
  if (type === 'idle') return 'waiting_for_input';
  if (type !== 'active') return null;
  const flags = Array.isArray(status?.activeFlags) ? status.activeFlags : [];
  if (flags.includes('waitingOnApproval')) return 'needs_permission';
  if (flags.includes('waitingOnUserInput')) return 'waiting_for_input';
  return 'working';
}

function reportLifecycle(state, previous) {
  if (!state || state === previous.value) return;
  previous.value = state;
  const node = process.env.RIREI_NODE_PATH;
  const hook = process.env.RIREI_LIFECYCLE_HOOK;
  if (!node || !hook) return;
  const child = spawn(node, [hook, state], {
    env: process.env,
    stdio: 'ignore',
  });
  child.on('error', () => undefined);
  child.unref();
}

function validServerUrl(value, portText) {
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'ws:' &&
      url.hostname === '127.0.0.1' &&
      url.port === String(port) &&
      url.pathname === '/' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
      ? value
      : null;
  } catch {
    return null;
  }
}

function startAppServer(token) {
  const child = spawn('codex', codexAppServerArgs(token), {
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let buffer = '';
    let diagnosticBytes = 0;
    let settled = false;
    const timer = setTimeout(() => fail(), STARTUP_TIMEOUT_MS);
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      reject(new Error('Codex lifecycle server did not start.'));
    };
    child.once('error', fail);
    child.once('close', fail);
    child.stderr.on('data', (chunk) => {
      diagnosticBytes += chunk.length;
      if (diagnosticBytes > 64 * 1024) return;
      buffer += chunk.toString('utf8');
      while (buffer.includes('\n')) {
        const offset = buffer.indexOf('\n');
        const line = buffer.slice(0, offset).replace(ANSI_CSI, '');
        buffer = buffer.slice(offset + 1);
        const match = LISTENING.exec(line);
        const url = match ? validServerUrl(match[1], match[2]) : null;
        if (!url) continue;
        settled = true;
        clearTimeout(timer);
        child.removeListener('error', fail);
        child.removeListener('close', fail);
        resolve({ child, url });
        return;
      }
    });
  });
}

function connectObserver(url, token, onLifecycle) {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket !== 'function') {
      reject(new Error('Codex lifecycle observation requires Node WebSocket.'));
      return;
    }
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const requestId = 'rirei-initialize';
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('Codex lifecycle observer did not initialize.'));
    }, STARTUP_TIMEOUT_MS);
    let initialized = false;
    const fail = () => {
      if (initialized) return;
      clearTimeout(timer);
      reject(new Error('Codex lifecycle observer did not initialize.'));
    };
    socket.addEventListener('open', () => {
      socket.send(
        JSON.stringify({
          id: requestId,
          method: 'initialize',
          params: {
            clientInfo: {
              name: 'rirei',
              title: 'Rirei',
              version: '0.1.0',
            },
            capabilities: {
              experimentalApi: false,
              requestAttestation: false,
            },
          },
        }),
      );
    });
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string' || event.data.length > 256 * 1024)
        return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!initialized && message.id === requestId) {
        if (!message.result) return fail();
        initialized = true;
        clearTimeout(timer);
        socket.send(JSON.stringify({ method: 'initialized' }));
        resolve(socket);
        return;
      }
      onLifecycle(codexLifecycleState(message));
      // Incoming server requests are deliberately left to the native TUI.
    });
    socket.addEventListener('error', fail);
    socket.addEventListener('close', fail);
  });
}

function childResult(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

async function stopSidecar(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const closed = new Promise((resolve) => child.once('close', resolve));
  child.kill('SIGTERM');
  const second = setTimeout(() => child.kill('SIGTERM'), 500);
  const forced = setTimeout(() => child.kill('SIGKILL'), 1500);
  second.unref();
  forced.unref();
  await closed;
  clearTimeout(second);
  clearTimeout(forced);
}

async function main() {
  let server;
  let observer;
  let tui;
  let stopping = false;
  let sidecarFailed = false;
  const lifecycle = { value: null };
  const interrupt = () => {
    if (tui) tui.kill('SIGINT');
    else stopping = true;
  };
  const terminate = () => {
    if (stopping) return;
    stopping = true;
    tui?.kill('SIGTERM');
    observer?.close();
    void stopSidecar(server);
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  process.on('SIGHUP', terminate);
  try {
    const token = randomBytes(32).toString('base64url');
    const started = await startAppServer(token);
    server = started.child;
    if (stopping) throw new Error('Codex lifecycle host was interrupted.');
    observer = await connectObserver(started.url, token, (state) =>
      reportLifecycle(state, lifecycle),
    );
    if (stopping) throw new Error('Codex lifecycle host was interrupted.');
    tui = spawn('codex', codexRemoteArgs(process.argv.slice(2), started.url), {
      env: { ...process.env, [CODEX_REMOTE_TOKEN_ENV]: token },
      stdio: 'inherit',
    });
    server.once('close', () => {
      if (stopping) return;
      sidecarFailed = true;
      tui?.kill('SIGTERM');
    });
    const result = await childResult(tui);
    stopping = true;
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
    process.off('SIGHUP', terminate);
    observer.close();
    await stopSidecar(server);
    if (sidecarFailed) return 1;
    if (typeof result.code === 'number') return result.code;
    return result.signal ? 128 : 1;
  } catch {
    stopping = true;
    tui?.kill('SIGTERM');
    observer?.close();
    await stopSidecar(server);
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
    process.off('SIGHUP', terminate);
    process.stderr.write('Codex lifecycle host could not start.\n');
    return 1;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
)
  process.exitCode = await main();
