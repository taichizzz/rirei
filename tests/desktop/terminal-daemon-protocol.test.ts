import { describe, expect, test, vi } from 'vitest';
import { TerminalDaemonClient } from '../../desktop/terminal-daemon-client.mjs';
import {
  DAEMON_MAX_IO_BYTES,
  DaemonFrameDecoder,
  encodeDaemonFrame,
  validStartRequest,
} from '../../desktop/terminal-daemon-protocol.mjs';

describe('terminal daemon framing', () => {
  test('preserves UTF-8 characters split across socket chunks', () => {
    const encoded = Buffer.from(
      encodeDaemonFrame({ type: 'event', event: 'output', text: 'a😀b' }),
    );
    const emoji = encoded.indexOf(Buffer.from('😀'));
    const decoder = new DaemonFrameDecoder();

    expect(decoder.push(encoded.subarray(0, emoji + 2))).toEqual([]);
    expect(decoder.push(encoded.subarray(emoji + 2))).toEqual([
      expect.objectContaining({ type: 'event', text: 'a😀b' }),
    ]);
  });

  test('bounds each frame by its encoded byte length', () => {
    const decoder = new DaemonFrameDecoder(32);

    expect(() => decoder.push(Buffer.alloc(33, 0x61))).toThrow(/size limit/);
    expect(decoder.push(encodeDaemonFrame({ type: 'ok' }))).toEqual([
      expect.objectContaining({ type: 'ok' }),
    ]);
  });

  test('rejects malformed UTF-8 instead of corrupting frame data', () => {
    const decoder = new DaemonFrameDecoder();
    const prefix = Buffer.from('{"v":2,"text":"');
    const suffix = Buffer.from('"}\n');

    expect(() =>
      decoder.push(Buffer.concat([prefix, Buffer.from([0xc3, 0x28]), suffix])),
    ).toThrow();
  });

  test('strictly validates terminal start requests', () => {
    const request = {
      kind: 'agent',
      command: 'run',
      agent: 'codex',
      project: '/tmp/project',
      workspaceId: 'default',
      size: { cols: 80, rows: 24 },
    };
    expect(validStartRequest(request)).toBe(true);
    expect(validStartRequest({ ...request, agent: 'arbitrary' })).toBe(false);
    expect(validStartRequest({ ...request, extra: true })).toBe(false);
    expect(validStartRequest({ ...request, model: '--dangerous' })).toBe(false);
    expect(validStartRequest({ ...request, size: { cols: 0, rows: 24 } })).toBe(
      false,
    );
  });

  test('chunks terminal writes at the daemon frame I/O limit', async () => {
    const client = new TerminalDaemonClient({});
    const request = vi.spyOn(client, 'request').mockResolvedValue({ ok: true });

    await client.write('terminal-id', Buffer.alloc(DAEMON_MAX_IO_BYTES + 7));

    expect(request).toHaveBeenCalledTimes(2);
    expect(
      request.mock.calls.map(
        ([, body]) => Buffer.from(body.data, 'base64').byteLength,
      ),
    ).toEqual([DAEMON_MAX_IO_BYTES, 7]);
  });

  test('clears cached control when the daemon rejects write or resize ownership', async () => {
    const client = new TerminalDaemonClient({});
    const request = vi.spyOn(client, 'request').mockResolvedValue({ ok: true });
    await client.acquireControl('terminal-id');
    expect(client.hasControl('terminal-id')).toBe(true);

    request.mockRejectedValueOnce(
      Object.assign(new Error('not controller'), { code: 'not_controller' }),
    );
    await expect(client.write('terminal-id', 'x')).rejects.toThrow(
      'not controller',
    );
    expect(client.hasControl('terminal-id')).toBe(false);

    request.mockResolvedValueOnce({ ok: true });
    await client.acquireControl('terminal-id');
    request.mockRejectedValueOnce(
      Object.assign(new Error('not controller'), { code: 'not_controller' }),
    );
    await expect(
      client.resize('terminal-id', { cols: 80, rows: 24 }),
    ).rejects.toThrow('not controller');
    expect(client.hasControl('terminal-id')).toBe(false);
  });
});
