import { describe, expect, test } from 'vitest';
import {
  DaemonFrameDecoder,
  encodeDaemonFrame,
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
    const prefix = Buffer.from('{"v":1,"text":"');
    const suffix = Buffer.from('"}\n');

    expect(() =>
      decoder.push(Buffer.concat([prefix, Buffer.from([0xc3, 0x28]), suffix])),
    ).toThrow();
  });
});
