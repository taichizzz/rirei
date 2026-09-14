import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { attachTerminalSession } from '../../src/tui/attach.js';

class FakeInput extends EventEmitter {
  isRaw = false;
  paused = true;
  rawModes: boolean[] = [];

  isPaused() {
    return this.paused;
  }
  setRawMode(value: boolean) {
    this.isRaw = value;
    this.rawModes.push(value);
    return this;
  }
  resume() {
    this.paused = false;
    return this;
  }
  pause() {
    this.paused = true;
    return this;
  }
}

class FakeOutput extends EventEmitter {
  columns = 100;
  rows = 30;
  chunks: Buffer[] = [];

  write(chunk: string | Uint8Array) {
    this.chunks.push(Buffer.from(chunk));
    return true;
  }
}

class MockDaemonClient extends EventEmitter {
  writtenData: Buffer[] = [];
  detached = 0;
  attachCalls = 0;
  activeFetches = 0;
  maxActiveFetches = 0;
  acquired = 0;
  released = 0;
  resized = 0;
  failWrite = false;
  failFetch = false;
  failInitialFetch = false;
  failResize = false;
  failAcquireCode: string | null = null;
  terminalStatus = 'running';
  terminalNextCursor: number | null = null;
  holdFetch: (() => void) | null = null;

  async attach(_terminalId: string, cursor = 0) {
    this.attachCalls += 1;
    this.activeFetches += 1;
    this.maxActiveFetches = Math.max(this.maxActiveFetches, this.activeFetches);
    if (this.attachCalls === 1 && this.failInitialFetch) {
      this.activeFetches -= 1;
      throw new Error('initial fetch failed');
    }
    if (this.attachCalls > 1 && this.holdFetch)
      await new Promise<void>((resolve) => {
        const held = this.holdFetch;
        this.holdFetch = () => {
          held?.();
          resolve();
        };
      });
    this.activeFetches -= 1;
    if (this.attachCalls > 1 && this.failFetch) throw new Error('fetch failed');
    const data =
      this.attachCalls === 1 ? Buffer.from('replay') : Buffer.from('x');
    return {
      data: data.toString('base64'),
      startCursor: cursor,
      endCursor: cursor + data.length,
      nextCursor: this.terminalNextCursor ?? cursor + data.length,
      terminal: { status: this.terminalStatus },
    };
  }

  async detach() {
    this.detached += 1;
    return { ok: true };
  }

  async acquireControl() {
    this.acquired += 1;
    if (this.failAcquireCode)
      throw Object.assign(new Error('acquire failed'), {
        code: this.failAcquireCode,
      });
    return { ok: true };
  }

  async releaseControl() {
    this.released += 1;
    return { ok: true };
  }

  async write(_terminalId: string, data: Uint8Array | string) {
    if (this.failWrite) throw new Error('write failed');
    this.writtenData.push(Buffer.from(data));
    return { ok: true };
  }

  async resize() {
    this.resized += 1;
    if (this.failResize) throw new Error('resize failed');
    return { ok: true };
  }

  async inspect() {
    return { status: 'running' };
  }
}

function fixture(
  client = new MockDaemonClient(),
  options: {
    clearOnExit?: boolean;
    readOnly?: boolean;
    returnToDashboard?: boolean;
  } = {},
) {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const signals = new EventEmitter();
  const attached = attachTerminalSession(client, 'terminal-id', {
    ...options,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    signalEmitter: signals as NodeJS.Process,
  });
  return { attached, client, stdin, stdout, signals };
}

async function ready(client: MockDaemonClient) {
  while (client.attachCalls === 0)
    await new Promise((resolve) => setTimeout(resolve, 1));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('terminal passthrough attachment', () => {
  it('writes the exact input bytes once and restores stream state on detach', async () => {
    const state = fixture();
    await ready(state.client);
    state.stdin.emit('data', Buffer.from('ls\n'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.client.writtenData).toEqual([Buffer.from('ls\n')]);

    state.stdin.emit('data', Buffer.from([0x1d]));
    await state.attached;
    expect(state.client.detached).toBe(1);
    expect(state.client.released).toBe(1);
    expect(state.stdin.rawModes).toEqual([true, false]);
    expect(state.stdin.paused).toBe(true);
    expect(state.stdin.listenerCount('data')).toBe(0);
    expect(state.stdout.listenerCount('resize')).toBe(0);
  });

  it('detaches with Ctrl+B then D without forwarding the reserved chord', async () => {
    const state = fixture();
    await ready(state.client);
    state.stdin.emit('data', Buffer.from([0x02]));
    state.stdin.emit('data', Buffer.from('d'));
    await state.attached;
    expect(state.client.writtenData).toEqual([]);
    expect(state.client.detached).toBe(1);
  });

  it('reserves Ctrl+Q for the dashboard while forwarding plain q', async () => {
    const state = fixture();
    await ready(state.client);
    state.stdin.emit('data', Buffer.from('q'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.client.writtenData).toEqual([Buffer.from('q')]);

    state.stdin.emit('data', Buffer.from([0x11]));
    await state.attached;
    expect(state.client.detached).toBe(1);
  });

  it('handles UTF-8 string chunks left by Ink on the input stream', async () => {
    const state = fixture();
    await ready(state.client);
    state.stdin.emit('data', 'type this');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.client.writtenData).toEqual([Buffer.from('type this')]);

    state.stdin.emit('data', '\x11');
    await state.attached;
    expect(state.client.detached).toBe(1);
  });

  it('forwards Ctrl+B when the next key is not the detach command', async () => {
    const state = fixture();
    await ready(state.client);
    state.stdin.emit('data', Buffer.from([0x02]));
    state.stdin.emit('data', Buffer.from('x'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(Buffer.concat(state.client.writtenData)).toEqual(
      Buffer.from([0x02, 0x78]),
    );
    state.stdin.emit('data', Buffer.from([0x1d]));
    await state.attached;
  });

  it.each(['exit', 'disconnected', 'SIGINT', 'SIGTERM'])(
    'cleans up when %s ends the attachment',
    async (event) => {
      const state = fixture();
      await ready(state.client);
      if (event === 'exit')
        state.client.emit('exit', { terminal: { id: 'terminal-id' } });
      else if (event === 'disconnected') state.client.emit('disconnected');
      else state.signals.emit(event);
      await state.attached;
      expect(state.client.detached).toBe(1);
      expect(state.stdin.rawModes.at(-1)).toBe(false);
      expect(state.signals.listenerCount('SIGINT')).toBe(0);
      expect(state.signals.listenerCount('SIGTERM')).toBe(0);
    },
  );

  it('cleans up after write or output-fetch failure', async () => {
    const writeClient = new MockDaemonClient();
    writeClient.failWrite = true;
    const writeState = fixture(writeClient);
    await ready(writeClient);
    writeState.stdin.emit('data', Buffer.from('x'));
    await writeState.attached;
    expect(writeClient.detached).toBe(1);

    const fetchClient = new MockDaemonClient();
    fetchClient.failFetch = true;
    const fetchState = fixture(fetchClient);
    await ready(fetchClient);
    fetchClient.emit('output_available', {
      terminalId: 'terminal-id',
      nextCursor: 10,
    });
    await fetchState.attached;
    expect(fetchClient.detached).toBe(1);
  });

  it('attempts detach cleanup when the initial attach response fails', async () => {
    const client = new MockDaemonClient();
    client.failInitialFetch = true;
    const state = fixture(client);

    await expect(state.attached).rejects.toThrow('initial fetch failed');
    expect(client.detached).toBe(1);
  });

  it('keeps read-only viewers from acquiring, resizing, or writing', async () => {
    const state = fixture(new MockDaemonClient(), { readOnly: true });
    await ready(state.client);
    state.stdin.emit('data', Buffer.from('ignored'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    state.stdin.emit('data', Buffer.from([0x11]));
    await state.attached;

    expect(state.client.acquired).toBe(0);
    expect(state.client.resized).toBe(0);
    expect(state.client.writtenData).toEqual([]);
  });

  it('drains a session that finalizes before control can be acquired', async () => {
    const client = new MockDaemonClient();
    client.failAcquireCode = 'not_running';
    client.terminalNextCursor = 8;
    const state = fixture(client);

    await state.attached;

    expect(client.attachCalls).toBe(3);
    expect(client.acquired).toBe(1);
    expect(client.resized).toBe(0);
    expect(client.detached).toBe(1);
    expect(state.stdin.rawModes).toEqual([]);
  });

  it('replays an already-final session without acquiring control', async () => {
    const client = new MockDaemonClient();
    client.terminalStatus = 'completed';
    client.terminalNextCursor = 8;
    const state = fixture(client);

    await state.attached;

    expect(client.attachCalls).toBe(3);
    expect(client.acquired).toBe(0);
    expect(client.resized).toBe(0);
    expect(client.detached).toBe(1);
    expect(state.stdin.rawModes).toEqual([]);
  });

  it('releases control and the viewer attachment when setup fails', async () => {
    const client = new MockDaemonClient();
    client.failResize = true;
    const state = fixture(client);

    await expect(state.attached).rejects.toThrow('resize failed');
    expect(client.acquired).toBe(1);
    expect(client.released).toBe(1);
    expect(client.detached).toBe(1);
    expect(state.stdin.listenerCount('data')).toBe(0);
    expect(client.listenerCount('control_revoked')).toBe(0);
  });

  it('detaches immediately when another client takes control', async () => {
    const state = fixture();
    await ready(state.client);

    state.client.emit('control_revoked', {
      terminalId: 'terminal-id',
      reason: 'takeover',
    });
    await state.attached;

    expect(state.client.detached).toBe(1);
    expect(state.client.listenerCount('control_revoked')).toBe(0);
    expect(Buffer.concat(state.stdout.chunks).toString()).toContain(
      'Terminal control was taken over',
    );
  });

  it('drains queued output before completing on exit', async () => {
    const state = fixture();
    await ready(state.client);

    state.client.emit('output_available', {
      terminalId: 'terminal-id',
      nextCursor: 8,
    });
    state.client.emit('exit', {
      terminal: { id: 'terminal-id', nextCursor: 8 },
    });
    await state.attached;

    expect(state.client.attachCalls).toBe(3);
    expect(
      state.stdout.chunks.some((chunk) => chunk.equals(Buffer.from('replay'))),
    ).toBe(true);
    expect(
      state.stdout.chunks.filter((chunk) => chunk.equals(Buffer.from('x'))),
    ).toHaveLength(2);
  });

  it('serializes output reads when availability events overlap', async () => {
    const client = new MockDaemonClient();
    client.holdFetch = () => undefined;
    const state = fixture(client);
    await ready(client);
    client.emit('output_available', {
      terminalId: 'terminal-id',
      nextCursor: 7,
    });
    client.emit('output_available', {
      terminalId: 'terminal-id',
      nextCursor: 8,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(client.maxActiveFetches).toBe(1);
    client.holdFetch?.();
    await new Promise((resolve) => setTimeout(resolve, 5));
    state.signals.emit('SIGTERM');
    await state.attached;
    expect(client.maxActiveFetches).toBe(1);
  });

  it('can preserve the caller screen when returning to a dashboard', async () => {
    const state = fixture(new MockDaemonClient(), { clearOnExit: false });
    await ready(state.client);
    state.stdin.emit('data', Buffer.from([0x1d]));
    await state.attached;

    const clearScreen = Buffer.from('\x1b[2J\x1b[H');
    expect(
      state.stdout.chunks.filter((chunk) => chunk.equals(clearScreen)),
    ).toHaveLength(1);
  });
});
