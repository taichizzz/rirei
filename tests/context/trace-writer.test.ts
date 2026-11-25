import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { normalizeCodexExec } from '../../src/context/codex.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  consumeVisibleStream,
  VisibleTraceWriter,
} from '../../benchmarks/continuity/trace-writer.mjs';
import { visibleRecord } from '../../benchmarks/continuity/bidirectional.mjs';
import {
  ProviderMeasurement,
  measuredProviderMetrics,
} from '../../benchmarks/continuity/measurement.mjs';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function output() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rirei-trace-'));
  roots.push(root);
  return path.join(root, 'visible.jsonl');
}
function memoryHandle({
  split = Infinity,
  failWrite = 0,
  failSync = false,
  slow = false,
} = {}) {
  const parts: Buffer[] = [];
  let calls = 0;
  return {
    parts,
    handle: {
      write: async (bytes: Buffer, offset: number, length: number) => {
        calls++;
        if (slow) return new Promise<never>(() => {});
        if (calls === failWrite)
          throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        const count = Math.min(split, length);
        parts.push(Buffer.from(bytes.subarray(offset, offset + count)));
        return { bytesWritten: count };
      },
      sync: async () => {
        if (failSync)
          throw Object.assign(new Error('sync failed'), { code: 'EIO' });
      },
      close: async () => {},
    },
  };
}

describe('bounded visible trace stream', () => {
  it('retains truthful capture redaction flags without persisting the original secret in the trace', async () => {
    const secret = `sk-ant-${'x'.repeat(40)}`;
    const file = await output();
    const writer = await VisibleTraceWriter.create(file);
    let captured: ReturnType<typeof normalizeCodexExec>[number] | undefined;
    const record = {
      type: 'item.completed',
      item: { id: 'message', type: 'agent_message', text: `Visible ${secret}` },
    };
    await consumeVisibleStream(
      Readable.from([Buffer.from(JSON.stringify(record) + '\n')]),
      {
        writer,
        select: (value) => visibleRecord('codex', value),
        clock: () => 0,
        onRecord: async (value) => {
          captured = normalizeCodexExec(value, {
            providerSessionId: 'thread',
          })[0];
        },
      },
    );
    await writer.close();
    expect(captured).toMatchObject({ redacted: true });
    expect(captured?.text).not.toContain(secret);
    expect(await readFile(file, 'utf8')).not.toContain(secret);
  });
  it('streams split UTF-8, filters hidden blocks, redacts secrets, and commits complete records once', async () => {
    const file = await output();
    const writer = await VisibleTraceWriter.create(file);
    const secret = `sk-ant-${'x'.repeat(40)}`;
    const record = {
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'hidden reasoning' },
          { type: 'text', text: `😀 visible ${secret}` },
        ],
      },
    };
    const bytes = Buffer.from(JSON.stringify(record) + '\n');
    const emoji = bytes.indexOf(Buffer.from('😀'));
    await consumeVisibleStream(
      Readable.from([
        bytes.subarray(0, emoji + 1),
        bytes.subarray(emoji + 1, emoji + 3),
        bytes.subarray(emoji + 3),
      ]),
      {
        writer,
        select: (value) => visibleRecord('claude', value),
        clock: () => 12.5,
      },
    );
    const status = await writer.close();
    const saved = await readFile(file, 'utf8');
    expect(saved).toContain('😀 visible');
    expect(saved).not.toContain(secret);
    expect(saved).not.toContain('hidden reasoning');
    expect(saved).not.toContain('thinking');
    expect(JSON.parse(saved)._rirei).toMatchObject({
      sequence: 1,
      elapsedMs: 12.5,
    });
    expect(status).toMatchObject({
      receivedSequence: 1,
      durableSequence: 1,
      complete: true,
    });
  });
  it('handles short writes without duplicate prefixes or quadratic rewrite amplification', async () => {
    const memory = memoryHandle({ split: 17 });
    const writer = new VisibleTraceWriter(memory.handle);
    for (let index = 0; index < 200; index++)
      await writer.write({ type: 'event', value: index }, index);
    const status = await writer.close();
    const bytes = Buffer.concat(memory.parts);
    const rows = bytes
      .toString()
      .trim()
      .split('\n')
      .map((value) => JSON.parse(value));
    expect(rows.map((row) => row.value)).toEqual(
      Array.from({ length: 200 }, (_, index) => index),
    );
    expect(status.bytesWritten).toBe(bytes.length);
    expect(bytes.length).toBeLessThan(200 * 256);
    expect(status.durableSequence).toBe(200);
  });
  it('keeps received, written, and durable counts distinct after ENOSPC', async () => {
    const memory = memoryHandle({ failWrite: 2 });
    const writer = new VisibleTraceWriter(memory.handle, {
      syncEveryRecords: 1,
    });
    await writer.write({ value: 1 }, 1);
    await expect(writer.write({ value: 2 }, 2)).rejects.toMatchObject({
      code: 'ENOSPC',
    });
    expect(await writer.close()).toMatchObject({
      receivedSequence: 2,
      writtenSequence: 1,
      durableSequence: 1,
      complete: false,
      errorCode: 'ENOSPC',
    });
    expect(
      Buffer.concat(memory.parts).toString().trim().split('\n'),
    ).toHaveLength(1);
  });
  it('does not report durability after a final fsync failure', async () => {
    const memory = memoryHandle({ failSync: true });
    const writer = new VisibleTraceWriter(memory.handle);
    await writer.write({ value: 1 }, 1);
    await expect(writer.close()).rejects.toMatchObject({ code: 'EIO' });
    expect(writer.status()).toMatchObject({
      writtenSequence: 1,
      durableSequence: 0,
      complete: false,
    });
  });
  it('leaves an unterminated provider tail uncommitted and visible as incomplete', async () => {
    const memory = memoryHandle();
    const writer = new VisibleTraceWriter(memory.handle);
    const result = await consumeVisibleStream(
      Readable.from([Buffer.from('{"value":1}\n{"value":2}')]),
      { writer, select: (value) => value, clock: () => 0 },
    );
    expect(result.incompleteTailBytes).toBeGreaterThan(0);
    expect(await writer.close()).toMatchObject({
      writtenSequence: 1,
      durableSequence: 1,
      complete: false,
    });
    expect(Buffer.concat(memory.parts).toString()).not.toContain('"value":2');
  });
  it.each([Buffer.from([0xff, 10]), Buffer.from('{bad json}\n')])(
    'fails closed on invalid provider encoding/JSON',
    async (bytes) => {
      const memory = memoryHandle();
      const writer = new VisibleTraceWriter(memory.handle);
      await expect(
        consumeVisibleStream(Readable.from([bytes]), {
          writer,
          select: (value) => value,
          clock: () => 0,
        }),
      ).rejects.toThrow();
      expect(await writer.close()).toMatchObject({
        complete: false,
        durableSequence: 0,
      });
    },
  );
  it.each([{ maxLineBytes: 32 }, { maxTraceBytes: 32 }, { maxRecords: 0 }])(
    'enforces serialized resource limits',
    async (options) => {
      const memory = memoryHandle();
      const writer = new VisibleTraceWriter(memory.handle, options);
      await expect(
        writer.write({ text: 'a'.repeat(100) }, 0),
      ).rejects.toThrow();
      expect((await writer.close()).complete).toBe(false);
    },
  );
  it('times out stalled writes and capture callbacks', async () => {
    const stalled = new VisibleTraceWriter(
      memoryHandle({ slow: true }).handle,
      { writeTimeoutMs: 10 },
    );
    await expect(stalled.write({ value: 1 }, 0)).rejects.toMatchObject({
      code: 'TRACE_IO_TIMEOUT',
    });
    await stalled.close();
    const writer = new VisibleTraceWriter(memoryHandle().handle, {
      writeTimeoutMs: 10,
    });
    await expect(
      consumeVisibleStream(Readable.from([Buffer.from('{"value":1}\n')]), {
        writer,
        select: (value) => value,
        clock: () => 0,
        onRecord: () => new Promise(() => {}),
      }),
    ).rejects.toMatchObject({ code: 'TRACE_CALLBACK_TIMEOUT' });
    expect((await writer.close()).complete).toBe(false);
  });
});

describe('incremental measurements', () => {
  it('deduplicates streamed tool IDs while keeping authoritative final Claude usage', () => {
    const measurement = new ProviderMeasurement('claude');
    const start = {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'one',
            name: 'Edit',
            input: { file_path: 'src/a.mjs' },
          },
        ],
      },
    };
    measurement.observe(start, 10);
    measurement.observe(start, 12);
    measurement.observe(
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'one',
              content: 'edited',
              is_error: false,
            },
          ],
        },
      },
      30,
    );
    measurement.observe(
      {
        type: 'result',
        usage: {
          input_tokens: 5,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 7,
          output_tokens: 3,
        },
        num_turns: 2,
      },
      40,
    );
    expect(measurement.metrics()).toMatchObject({
      toolCalls: 1,
      inputTokens: 32,
      cachedInputTokens: 20,
      outputTokens: 3,
      nonCachedTokens: 15,
    });
    expect(measurement.timeline()).toMatchObject({
      firstEditRequestedMs: 10,
      firstUsefulActionMs: null,
      redundantWork: null,
    });
    expect(measurement.timeline().tools[0]).toMatchObject({
      observedDurationMs: 20,
      outputBytes: 6,
    });
  });
  it('preserves unknown interrupted usage and matches Codex counter replay without reasoning double count', () => {
    const records = [
      { type: 'turn.started' },
      { type: 'item.started', item: { id: 'edit', type: 'file_change' } },
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 100,
          cached_input_tokens: 80,
          output_tokens: 10,
          reasoning_output_tokens: 3,
        },
      },
    ];
    const measurement = new ProviderMeasurement('codex');
    measurement.observe(records[0]);
    measurement.observe(records[1]);
    expect(measurement.metrics()).toMatchObject({
      inputTokens: null,
      nonCachedTokens: null,
      toolCalls: 1,
      turnsBeforeFirstEdit: 0,
    });
    measurement.observe(records[2]);
    expect(measurement.metrics()).toEqual(
      measuredProviderMetrics(
        'codex',
        records.map((record) => JSON.stringify(record)).join('\n'),
      ),
    );
    expect(measurement.metrics()).toMatchObject({
      inputTokens: 100,
      outputTokens: 10,
      reasoningTokens: 3,
      nonCachedTokens: 30,
    });
  });
});
