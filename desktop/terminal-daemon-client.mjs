import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { lstat, readFile } from 'node:fs/promises';
import net from 'node:net';
import { hostname, uptime } from 'node:os';
import {
  DAEMON_PROTOCOL_VERSION,
  DaemonFrameDecoder,
  encodeDaemonFrame,
  validTerminalId,
} from './terminal-daemon-protocol.mjs';

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

function validDescriptor(descriptor, socketPath) {
  return (
    descriptor &&
    typeof descriptor === 'object' &&
    !Array.isArray(descriptor) &&
    descriptor.schemaVersion === 1 &&
    descriptor.protocolVersion === DAEMON_PROTOCOL_VERSION &&
    validTerminalId(descriptor.daemonId) &&
    Number.isSafeInteger(descriptor.pid) &&
    descriptor.pid > 0 &&
    descriptor.socketPath === socketPath &&
    typeof descriptor.reconnectToken === 'string' &&
    /^[A-Za-z0-9_-]{32,256}$/.test(descriptor.reconnectToken) &&
    typeof descriptor.createdAt === 'string' &&
    Number.isFinite(Date.parse(descriptor.createdAt))
  );
}

function daemonError(message, code) {
  return Object.assign(new Error(message), { daemonCode: code });
}

function recoverableConnectionError(error) {
  return ['ENOENT', 'ECONNREFUSED'].includes(error?.code);
}

function currentBootId(now = Date.now()) {
  return `${hostname()}:${Math.round((now - uptime() * 1000) / 60_000)}`;
}

export function isSafeDaemonDescriptorFile(
  descriptorFile,
  platform = process.platform,
  currentUid = process.getuid?.(),
) {
  if (!descriptorFile.isFile() || descriptorFile.isSymbolicLink()) return false;
  if (platform === 'win32') return true;
  if (currentUid !== undefined && descriptorFile.uid !== currentUid)
    return false;
  return (descriptorFile.mode & 0o077) === 0;
}

export class TerminalDaemonClient extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.socket = null;
    this.pending = new Map();
    this.inventory = new Map();
    this.requestId = 1;
    this.connected = false;
    this.connecting = null;
    this.starting = null;
    this.inventoryRevision = 0;
    this.daemonId = null;
    this.daemonPid = null;
    this.daemonBootId = null;
  }

  async connectOrStart() {
    if (this.starting) return this.starting;
    const starting = this.openOrStart();
    this.starting = starting;
    try {
      await starting;
    } finally {
      if (this.starting === starting) this.starting = null;
    }
  }

  async openOrStart() {
    try {
      await this.connect();
      return;
    } catch (error) {
      if (!recoverableConnectionError(error)) throw error;
      await this.spawnDaemon();
    }
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        await this.connect();
        return;
      } catch {
        await new Promise((resolve) => globalThis.setTimeout(resolve, 50));
      }
    }
    throw new Error('Could not connect to the terminal daemon.');
  }

  async spawnDaemon() {
    const executable = this.options.executable;
    const args = [
      ...(this.options.runAsNode ? [this.options.entry] : []),
      '--socket',
      this.options.socketPath,
      '--descriptor',
      this.options.descriptorPath,
      '--bridge',
      this.options.bridgePath,
      '--cli',
      this.options.cliPath,
      '--node',
      this.options.nodePath,
    ];
    await new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: {
          ...process.env,
          ...(this.options.pathValue ? { PATH: this.options.pathValue } : {}),
          ...(this.options.runAsNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
        },
      });
      child.once('error', reject);
      child.once('spawn', () => {
        child.removeListener('error', reject);
        child.on('error', () => undefined);
        child.unref();
        resolve();
      });
    });
  }

  async connect() {
    if (this.connecting) return this.connecting;
    if (this.connected) return;
    const connecting = this.openConnection();
    this.connecting = connecting;
    try {
      await connecting;
    } finally {
      if (this.connecting === connecting) this.connecting = null;
    }
  }

  async openConnection() {
    const descriptorFile = await lstat(this.options.descriptorPath);
    if (!isSafeDaemonDescriptorFile(descriptorFile))
      throw new Error('Unsafe terminal daemon descriptor permissions.');
    const descriptor = JSON.parse(
      await readFile(this.options.descriptorPath, 'utf8'),
    );
    if (!validDescriptor(descriptor, this.options.socketPath))
      throw new Error('Invalid terminal daemon descriptor.');
    const queuedFrames = [];
    let active = false;
    const socket = await new Promise((resolve, reject) => {
      const socket = net.createConnection(descriptor.socketPath);
      const decoder = new DaemonFrameDecoder();
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        socket.destroy();
        reject(error);
      };
      const timer = globalThis.setTimeout(
        () => fail(new Error('Terminal daemon authentication timed out.')),
        3000,
      );
      const closed = () =>
        fail(new Error('Terminal daemon disconnected during authentication.'));
      socket.once('error', fail);
      socket.once('close', closed);
      socket.on('data', (chunk) => {
        let frames;
        try {
          frames = decoder.push(chunk);
        } catch (error) {
          if (settled) socket.destroy(error);
          else fail(error);
          return;
        }
        for (const frame of frames) {
          if (!settled && frame.type === 'welcome') {
            if (frame.daemonId !== descriptor.daemonId) {
              fail(new Error('Terminal daemon identity does not match.'));
              return;
            }
            settled = true;
            globalThis.clearTimeout(timer);
            this.daemonId = frame.daemonId;
            this.daemonPid = Number.isSafeInteger(frame.pid) ? frame.pid : null;
            this.daemonBootId =
              typeof frame.bootId === 'string'
                ? frame.bootId
                : typeof descriptor.bootId === 'string'
                  ? descriptor.bootId
                  : currentBootId();
            resolve(socket);
            continue;
          }
          if (settled) {
            if (active) this.handleFrame(frame, socket);
            else queuedFrames.push(frame);
          }
        }
      });
      socket.once('connect', () =>
        socket.write(
          encodeDaemonFrame({
            type: 'hello',
            token: descriptor.reconnectToken,
            clientId: randomUUID(),
            pid: process.pid,
          }),
        ),
      );
    });
    if (socket.destroyed)
      throw new Error('Terminal daemon disconnected during authentication.');
    this.socket = socket;
    this.connected = true;
    socket.on('error', () => this.disconnect(socket));
    socket.on('close', () => this.disconnect(socket));
    for (const frame of queuedFrames) this.handleFrame(frame, socket);
    active = true;
    try {
      await this.refreshInventory();
    } catch (error) {
      this.disconnect(socket);
      throw error;
    }
    this.emit('connected');
  }

  disconnect(socket = this.socket) {
    if (socket !== this.socket) return;
    const wasConnected = this.connected;
    this.connected = false;
    this.socket = null;
    if (socket && !socket.destroyed) socket.destroy();
    for (const pending of this.pending.values()) {
      globalThis.clearTimeout(pending.timer);
      pending.reject(new Error('Terminal daemon disconnected.'));
    }
    this.pending.clear();
    if (wasConnected) this.emit('disconnected');
  }

  handleFrame(frame, socket = this.socket) {
    if (socket !== this.socket) return;
    if (frame.type === 'response') {
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      this.pending.delete(frame.id);
      globalThis.clearTimeout(pending.timer);
      if (frame.ok) {
        this.updateInventory(
          pending.op,
          pending.body,
          frame.body,
          pending.inventoryRevision,
        );
        pending.resolve(frame.body);
      } else {
        pending.reject(
          Object.assign(
            new Error(
              frame.error?.message ?? 'Terminal daemon request failed.',
            ),
            frame.error,
          ),
        );
      }
      return;
    }
    if (frame.type === 'event') {
      this.inventoryRevision += 1;
      if (frame.terminal) this.updateTerminal(frame.terminal);
      if (
        frame.event === 'output_available' &&
        typeof frame.terminalId === 'string' &&
        Number.isSafeInteger(frame.nextCursor)
      ) {
        const terminal = this.inventory.get(frame.terminalId);
        if (terminal)
          this.inventory.set(frame.terminalId, {
            ...terminal,
            outputSequence: frame.nextCursor,
            nextCursor: frame.nextCursor,
          });
      }
      if (frame.event === 'forgotten' && typeof frame.terminalId === 'string')
        this.inventory.delete(frame.terminalId);
      this.emit(frame.event, frame);
    }
  }

  updateInventory(op, requestBody, responseBody, inventoryRevision) {
    if (op === 'list' && Array.isArray(responseBody)) {
      const listed = new Set();
      for (const item of responseBody) {
        if (!item || typeof item.id !== 'string') continue;
        listed.add(item.id);
        this.updateTerminal(item);
      }
      if (this.inventoryRevision === inventoryRevision)
        for (const terminalId of this.inventory.keys())
          if (!listed.has(terminalId)) this.inventory.delete(terminalId);
      return;
    }
    if (op === 'forget') {
      this.inventory.delete(requestBody.terminalId);
      return;
    }
    const terminal = responseBody?.terminal ?? responseBody;
    if (terminal && typeof terminal.id === 'string')
      this.updateTerminal(terminal);
  }

  updateTerminal(terminal) {
    const existing = this.inventory.get(terminal.id);
    if (
      existing &&
      Number.isSafeInteger(existing.sequence) &&
      Number.isSafeInteger(terminal.sequence) &&
      terminal.sequence < existing.sequence
    )
      return;
    const nextCursor = Math.max(
      Number.isSafeInteger(existing?.nextCursor) ? existing.nextCursor : 0,
      Number.isSafeInteger(terminal.nextCursor) ? terminal.nextCursor : 0,
    );
    this.inventory.set(terminal.id, {
      ...terminal,
      outputSequence: nextCursor,
      nextCursor,
    });
  }

  request(op, body = {}) {
    if (!this.socket || !this.connected)
      return Promise.reject(new Error('Terminal daemon is unavailable.'));
    const id = String(this.requestId++);
    const socket = this.socket;
    const frame = encodeDaemonFrame({ type: 'request', id, op, body });
    const timeoutMs =
      Number.isFinite(this.options.requestTimeoutMs) &&
      this.options.requestTimeoutMs > 0
        ? this.options.requestTimeoutMs
        : DEFAULT_REQUEST_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(
          daemonError('Terminal daemon request timed out.', 'request_timeout'),
        );
      }, timeoutMs);
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        op,
        body,
        inventoryRevision: this.inventoryRevision,
      });
      try {
        socket.write(frame, (error) => {
          if (!error) return;
          const pending = this.pending.get(id);
          if (!pending) return;
          this.pending.delete(id);
          globalThis.clearTimeout(pending.timer);
          pending.reject(error);
          socket.destroy();
        });
      } catch (error) {
        this.pending.delete(id);
        globalThis.clearTimeout(timer);
        reject(error);
      }
    });
  }

  async refreshInventory() {
    return this.request('list');
  }

  list() {
    return this.request('list');
  }
  start(body) {
    return this.request('start', body);
  }
  inspect(terminalId) {
    return this.request('inspect', { terminalId });
  }
  attach(terminalId, cursor = 0) {
    return this.request('attach', { terminalId, cursor });
  }
  detach(terminalId) {
    return this.request('detach', { terminalId });
  }
  write(terminalId, data) {
    return this.request('write', {
      terminalId,
      data: Buffer.from(data).toString('base64'),
    });
  }
  resize(terminalId, size) {
    return this.request('resize', { terminalId, ...size });
  }
  setWaiting(terminalId, attentionKind = 'input') {
    return this.request('set_waiting', {
      terminalId,
      attentionKind,
    });
  }
  setLifecycle(terminalId, lifecycleState) {
    return this.request('set_lifecycle', { terminalId, lifecycleState });
  }
  interrupt(terminalId) {
    return this.request('interrupt', { terminalId });
  }
  stop(terminalId) {
    return this.request('stop', { terminalId });
  }
  setHidden(terminalId, hidden) {
    return this.request('set_hidden', { terminalId, hidden });
  }
  forget(terminalId) {
    return this.request('forget', { terminalId });
  }
}
