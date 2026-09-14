import { spawn } from 'node:child_process';

export const BRIDGE_WORKER_PROTOCOL_VERSION = 1;
export const BRIDGE_WORKER_MAX_FRAME_BYTES = 128 * 1024;
const BRIDGE_WORKER_MAX_PENDING = 64;

function readBoundedLines(input, onLine, onOverflow) {
  let parts = [];
  let frameBytes = 0;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    parts = [];
    frameBytes = 0;
    input.off('data', onData);
    input.off('end', onEnd);
  };
  const emitLine = () => {
    const line = Buffer.concat(parts, frameBytes).toString('utf8');
    parts = [];
    frameBytes = 0;
    onLine(line);
  };
  const onData = (value) => {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    let offset = 0;
    while (!closed && offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.length : newline;
      const length = end - offset;
      if (frameBytes + length > BRIDGE_WORKER_MAX_FRAME_BYTES) {
        close();
        onOverflow();
        return;
      }
      if (length > 0) {
        parts.push(Buffer.from(chunk.subarray(offset, end)));
        frameBytes += length;
      }
      if (newline === -1) return;
      emitLine();
      offset = newline + 1;
    }
  };
  const onEnd = () => {
    if (!closed && frameBytes > 0) emitLine();
  };

  input.on('data', onData);
  input.on('end', onEnd);
  return { close };
}

export class DaemonBridgeWorker {
  constructor({ nodePath, cliPath }) {
    this.nodePath = nodePath;
    this.cliPath = cliPath;
    this.child = null;
    this.responseReader = null;
    this.pending = new Map();
    this.requestId = 1;
    this.stopping = false;
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  resetWorker(child, error) {
    if (this.child !== child) return;
    this.child = null;
    this.responseReader?.close();
    this.responseReader = null;
    this.rejectPending(error);
  }

  ensureWorker() {
    if (this.child && !this.child.killed && this.child.exitCode === null) {
      return this.child;
    }

    const child = spawn(this.nodePath, [this.cliPath, 'bridge', '--worker'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });

    this.child = child;
    this.responseReader = readBoundedLines(
      child.stdout,
      (line) => {
        if (!line.trim()) return;
        try {
          const msg = JSON.parse(line);
          if (
            !msg ||
            typeof msg !== 'object' ||
            msg.v !== BRIDGE_WORKER_PROTOCOL_VERSION ||
            typeof msg.id !== 'string' ||
            typeof msg.ok !== 'boolean'
          ) {
            throw new Error('Invalid bridge worker response.');
          }
          const pending = this.pending.get(msg.id);
          if (pending) {
            this.pending.delete(msg.id);
            clearTimeout(pending.timer);
            if (msg.ok) pending.resolve();
            else pending.reject(new Error(msg.error ?? 'Bridge worker error'));
          }
        } catch (error) {
          this.resetWorker(
            child,
            error instanceof Error
              ? error
              : new Error('Invalid bridge worker response.'),
          );
          child.kill('SIGKILL');
        }
      },
      () => {
        const error = new Error(
          'Bridge worker response exceeds the size limit.',
        );
        this.resetWorker(child, error);
        child.kill('SIGKILL');
      },
    );

    child.on('close', () => {
      this.resetWorker(child, new Error('Bridge worker exited'));
    });

    child.on('error', (error) => this.resetWorker(child, error));
    child.stdin.on('error', (error) => this.resetWorker(child, error));

    return child;
  }

  request(message, timeoutMessage) {
    if (this.stopping)
      return Promise.reject(new Error('Bridge worker is stopping'));
    if (this.pending.size >= BRIDGE_WORKER_MAX_PENDING)
      return Promise.reject(new Error('Bridge worker request queue is full.'));
    const id = String(this.requestId++);
    const frame = `${JSON.stringify({
      v: BRIDGE_WORKER_PROTOCOL_VERSION,
      id,
      ...message,
    })}\n`;
    if (Buffer.byteLength(frame) > BRIDGE_WORKER_MAX_FRAME_BYTES) {
      return Promise.reject(
        new Error('Bridge worker request exceeds the size limit.'),
      );
    }
    const child = this.ensureWorker();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        const error = new Error(timeoutMessage);
        this.resetWorker(child, error);
        child.kill('SIGKILL');
      }, 5_000);

      this.pending.set(id, { resolve, reject, timer });

      try {
        child.stdin.write(frame, (error) => {
          if (!error) return;
          this.resetWorker(child, error);
          child.kill('SIGKILL');
        });
      } catch (err) {
        this.resetWorker(
          child,
          err instanceof Error ? err : new Error(String(err)),
        );
        child.kill('SIGKILL');
      }
    });
  }

  async updateProviderStatus(project, terminalId, observation) {
    return this.request(
      { type: 'update', project, terminalId, observation },
      'Provider state synchronization timed out.',
    );
  }

  async registerBridge(project, terminalId, bridge) {
    return this.request(
      {
        type: 'register',
        project,
        terminalId,
        instanceId: bridge.instanceId,
        pid: bridge.pid,
        protocolVersion: bridge.protocolVersion,
      },
      'Bridge registration timed out.',
    );
  }

  stop() {
    this.stopping = true;
    const child = this.child;
    if (child) this.resetWorker(child, new Error('Bridge worker stopped'));
    else this.rejectPending(new Error('Bridge worker stopped'));
    if (child) child.kill('SIGTERM');
  }
}
