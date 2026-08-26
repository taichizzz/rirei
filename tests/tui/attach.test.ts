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
  failWrite = false;
  failFetch = false;
  holdFetch: (() => void) | null = null;

  async attach(_terminalId: string, cursor = 0) {
    this.attachCalls += 1;
    this.activeFetches += 1;
    this.maxActiveFetches = Math.max(this.maxActiveFetches, this.activeFetches);
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
      nextCursor: cursor + data.length,
    };
  }

  async detach() {
    this.detached += 1;
    return { ok: true };
  }

  async write(_terminalId: string, data: Uint8Array | string) {
    if (this.failWrite) throw new Error('write failed');
    this.writtenData.push(Buffer.from(data));
    return { ok: true };
  }

  async resize() {
    return { ok: true };
  }

  async inspect() {
    return { status: 'running' };
  }
}

function fixture(client = new MockDaemonClient()) {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const signals = new EventEmitter();
  const attached = attachTerminalSession(client, 'terminal-id', {
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
    expect(state.stdin.rawModes).toEqual([true, false]);
    expect(state.stdin.paused).toBe(true);
    expect(state.stdin.listenerCount('data')).toBe(0);
    expect(state.stdout.listenerCount('resize')).toBe(0);
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
});
