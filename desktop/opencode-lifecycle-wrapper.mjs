import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const dependencyUrl = import.meta.url.includes('.asar.unpacked/')
  ? import.meta.url.replace('.asar.unpacked/', '.asar/')
  : import.meta.url;
const spawn = createRequire(dependencyUrl)('cross-spawn');
const STARTUP_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 2_000;
const EVENT_IDLE_TIMEOUT_MS = 15_000;
const MAX_EVENT_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export function openCodeNetworkArgs(args) {
  if (
    args.some(
      (arg) =>
        arg === '--mini' ||
        arg === '--mdns' ||
        arg.startsWith('--port') ||
        arg.startsWith('--hostname') ||
        arg.startsWith('--mdns-domain'),
    )
  )
    throw new Error(
      'OpenCode lifecycle host received conflicting network flags.',
    );
  return ['--hostname', '127.0.0.1', '--port', '0', ...args];
}

export class OpenCodeLifecycleTracker {
  constructor(onState) {
    this.onState = onState;
    this.permissions = new Set();
    this.questions = new Set();
    this.sessions = new Map();
    this.current = null;
  }

  replace(permissionValues, questionValues, statusValues) {
    this.permissions = new Set(
      Array.isArray(permissionValues)
        ? permissionValues.map((item) => item?.id).filter(Boolean)
        : [],
    );
    this.questions = new Set(
      Array.isArray(questionValues)
        ? questionValues.map((item) => item?.id).filter(Boolean)
        : [],
    );
    this.sessions = new Map(
      statusValues && typeof statusValues === 'object'
        ? Object.entries(statusValues).filter(([, status]) =>
            ['busy', 'retry'].includes(status?.type),
          )
        : [],
    );
    this.publish();
  }

  apply(event) {
    const properties = event?.properties;
    if (!properties || typeof properties !== 'object') return;
    if (event.type === 'permission.asked' && properties.id)
      this.permissions.add(properties.id);
    else if (event.type === 'permission.replied' && properties.requestID)
      this.permissions.delete(properties.requestID);
    else if (event.type === 'question.asked' && properties.id)
      this.questions.add(properties.id);
    else if (
      ['question.replied', 'question.rejected'].includes(event.type) &&
      properties.requestID
    )
      this.questions.delete(properties.requestID);
    else if (event.type === 'session.status' && properties.sessionID) {
      if (['busy', 'retry'].includes(properties.status?.type))
        this.sessions.set(properties.sessionID, properties.status);
      else this.sessions.delete(properties.sessionID);
    } else if (event.type === 'session.idle' && properties.sessionID)
      this.sessions.delete(properties.sessionID);
    else return;
    this.publish();
  }

  publish() {
    const state =
      this.permissions.size > 0
        ? 'needs_permission'
        : this.questions.size > 0
          ? 'waiting_for_input'
          : this.sessions.size > 0
            ? 'working'
            : 'waiting_for_input';
    if (state === this.current) return;
    this.current = state;
    this.onState(state);
  }
}

function reportLifecycle(state) {
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

function authorization(password) {
  return `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
}

export async function readBoundedJson(response) {
  if (!response.ok) throw new Error('OpenCode lifecycle endpoint failed.');
  if (!response.body)
    throw new Error('OpenCode lifecycle endpoint returned no body.');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('OpenCode lifecycle response is too large.');
      }
      chunks.push(Buffer.from(item.value));
    }
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
  } finally {
    reader.releaseLock();
  }
}

async function fetchWithDeadline(url, init, parentSignal, timeoutMs) {
  const controller = new AbortController();
  const abort = () => controller.abort(parentSignal.reason);
  if (parentSignal.aborted) abort();
  else parentSignal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error('OpenCode lifecycle request timed out.')),
    timeoutMs,
  );
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return {
      response,
      clearDeadline() {
        clearTimeout(timer);
      },
      dispose() {
        clearTimeout(timer);
        parentSignal.removeEventListener('abort', abort);
      },
    };
  } catch (error) {
    clearTimeout(timer);
    parentSignal.removeEventListener('abort', abort);
    throw error;
  }
}

export async function endpointJson(
  baseURL,
  pathname,
  headers,
  signal,
  timeoutMs = REQUEST_TIMEOUT_MS,
) {
  const request = await fetchWithDeadline(
    new URL(pathname, baseURL),
    { headers },
    signal,
    timeoutMs,
  );
  try {
    return await readBoundedJson(request.response);
  } finally {
    request.dispose();
  }
}

async function findListeningPortsForPid(pid) {
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync('netstat', ['-ano', '-p', 'tcp'], {
        encoding: 'utf8',
        timeout: 1000,
        maxBuffer: 512 * 1024,
      });
      const ports = [];
      const pidStr = String(pid);
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('TCP')) continue;
        const parts = trimmed.split(/\s+/);
        if (
          parts.length >= 5 &&
          parts[3] === 'LISTENING' &&
          parts[4] === pidStr
        ) {
          const lastColon = parts[1].lastIndexOf(':');
          if (lastColon !== -1) {
            const port = Number.parseInt(parts[1].slice(lastColon + 1), 10);
            if (port > 0 && port <= 65535) ports.push(port);
          }
        }
      }
      return ports;
    } catch {
      return [];
    }
  }

  const lsofCandidates = ['/usr/sbin/lsof', 'lsof'];
  for (const lsofBin of lsofCandidates) {
    try {
      const { stdout } = await execFileAsync(
        lsofBin,
        ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn'],
        { encoding: 'utf8', timeout: 1000, maxBuffer: 64 * 1024 },
      );
      const ports = stdout
        .split('\n')
        .map(
          (line) =>
            /^n(?:127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):([1-9][0-9]{0,4})$/.exec(
              line,
            )?.[1],
        )
        .filter(Boolean)
        .map((p) => Number(p));
      if (ports.length > 0) return ports;
    } catch {
      // Continue to next candidate
    }
  }

  try {
    const { stdout } = await execFileAsync('ss', ['-tlnp'], {
      encoding: 'utf8',
      timeout: 1000,
      maxBuffer: 256 * 1024,
    });
    const ports = [];
    const pidPattern = new RegExp(`pid=${pid}(?:,|\\))`);
    for (const line of stdout.split('\n')) {
      if (line.includes('LISTEN') && pidPattern.test(line)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 4) {
          const lastColon = parts[3].lastIndexOf(':');
          if (lastColon !== -1) {
            const port = Number.parseInt(parts[3].slice(lastColon + 1), 10);
            if (port > 0 && port <= 65535) ports.push(port);
          }
        }
      }
    }
    return ports;
  } catch {
    return [];
  }
}

async function discoverPort(child, headers, signal) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode)
      throw new Error('OpenCode exited before lifecycle monitoring started.');
    try {
      const ports = await findListeningPortsForPid(child.pid);
      for (const port of ports) {
        if (port > 65_535) continue;
        const baseURL = `http://127.0.0.1:${port}/`;
        try {
          const health = await endpointJson(
            baseURL,
            '/global/health',
            headers,
            signal,
            750,
          );
          if (health?.healthy === true) return baseURL;
        } catch {
          // The listener may not have completed startup yet.
        }
      }
    } catch {
      // Ports query may fail until socket is bound
    }
    await abortableDelay(100, signal);
  }
  throw new Error('OpenCode lifecycle server did not start.');
}

async function reconcile(baseURL, directory, headers, signal, tracker) {
  const query = `?directory=${encodeURIComponent(directory)}`;
  const [permissions, questions, statuses] = await Promise.all([
    endpointJson(baseURL, `/permission${query}`, headers, signal),
    endpointJson(baseURL, `/question${query}`, headers, signal),
    endpointJson(baseURL, `/session/status${query}`, headers, signal),
  ]);
  tracker.replace(permissions, questions, statuses);
}

function abortableDelay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const aborted = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', aborted);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', aborted, { once: true });
  });
}

function readWithDeadline(reader, signal, idleTimeoutMs) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      if (error) reject(error);
      else resolve(value);
    };
    const aborted = () => finish(signal.reason);
    const timer = setTimeout(() => {
      void reader.cancel();
      finish(new Error('OpenCode lifecycle event stream became idle.'));
    }, idleTimeoutMs);
    signal.addEventListener('abort', aborted, { once: true });
    reader.read().then(
      (value) => finish(null, value),
      (error) => finish(error),
    );
  });
}

export async function consumeEvents(
  response,
  tracker,
  signal,
  idleTimeoutMs = EVENT_IDLE_TIMEOUT_MS,
) {
  if (!response.ok || !response.body)
    throw new Error('OpenCode lifecycle event stream failed.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let data = [];
  let eventBytes = 0;
  try {
    while (!signal.aborted) {
      const item = await readWithDeadline(reader, signal, idleTimeoutMs);
      if (item.done) break;
      buffer += decoder.decode(item.value, { stream: true });
      if (Buffer.byteLength(buffer) > MAX_EVENT_BYTES)
        throw new Error('OpenCode event is too large.');
      while (buffer.includes('\n')) {
        const offset = buffer.indexOf('\n');
        const line = buffer.slice(0, offset).replace(/\r$/, '');
        buffer = buffer.slice(offset + 1);
        if (line.startsWith('data:')) {
          const value = line.slice(5).trimStart();
          eventBytes += Buffer.byteLength(value) + 1;
          if (eventBytes > MAX_EVENT_BYTES)
            throw new Error('OpenCode event is too large.');
          data.push(value);
          continue;
        }
        if (line || data.length === 0) continue;
        const text = data.join('\n');
        data = [];
        eventBytes = 0;
        try {
          tracker.apply(JSON.parse(text));
        } catch {
          // Malformed or unrelated events never affect provider execution.
        }
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function monitor(
  baseURL,
  directory,
  headers,
  controller,
  tracker,
  ready,
) {
  let announced = false;
  while (!controller.signal.aborted) {
    try {
      const query = `?directory=${encodeURIComponent(directory)}`;
      const request = await fetchWithDeadline(
        new URL(`/event${query}`, baseURL),
        { headers: { ...headers, Accept: 'text/event-stream' } },
        controller.signal,
        REQUEST_TIMEOUT_MS,
      );
      request.clearDeadline();
      try {
        await reconcile(
          baseURL,
          directory,
          headers,
          controller.signal,
          tracker,
        );
        if (!announced) {
          announced = true;
          ready.resolve();
        }
        await consumeEvents(request.response, tracker, controller.signal);
      } finally {
        request.dispose();
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      if (!announced) {
        ready.reject(error);
        return;
      }
    }
    await abortableDelay(500, controller.signal).catch(() => undefined);
  }
}

function childResult(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

async function main() {
  let child;
  let stopping = false;
  const controller = new AbortController();
  const interrupt = () => {
    if (child) child.kill('SIGINT');
    else stopping = true;
  };
  const terminate = () => {
    if (stopping) return;
    stopping = true;
    controller.abort();
    child?.kill('SIGTERM');
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  process.on('SIGHUP', terminate);
  try {
    const password = randomBytes(32).toString('hex');
    const headers = { Authorization: authorization(password) };
    child = spawn('opencode', openCodeNetworkArgs(process.argv.slice(2)), {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OPENCODE_SERVER_USERNAME: 'opencode',
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_DISABLE_AUTOUPDATE: '1',
      },
      stdio: 'inherit',
    });
    const resultPromise = childResult(child);
    void resultPromise.then(
      () => controller.abort(),
      () => controller.abort(),
    );
    if (stopping) throw new Error('OpenCode lifecycle host was interrupted.');
    const baseURL = await discoverPort(child, headers, controller.signal);
    let resolveReady;
    let rejectReady;
    const readyPromise = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const tracker = new OpenCodeLifecycleTracker(reportLifecycle);
    void monitor(baseURL, process.cwd(), headers, controller, tracker, {
      resolve: resolveReady,
      reject: rejectReady,
    });
    await readyPromise;

    const result = await resultPromise;
    stopping = true;
    controller.abort();
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
    process.off('SIGHUP', terminate);
    if (typeof result.code === 'number') return result.code;
    return result.signal ? 128 : 1;
  } catch {
    stopping = true;
    controller.abort();
    child?.kill('SIGTERM');
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
    process.off('SIGHUP', terminate);
    process.stderr.write('OpenCode lifecycle host could not start.\n');
    return 1;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
)
  process.exitCode = await main();
