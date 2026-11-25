import { open } from 'node:fs/promises';
import { TextDecoder } from 'node:util';
import { performance } from 'node:perf_hooks';
import { redactSecrets } from '../../src/safety/redaction.ts';

export const TRACE_LIMITS = Object.freeze({
  maxLineBytes: 256 * 1024,
  maxTraceBytes: 16 * 1024 * 1024,
  maxRecords: 20000,
  syncEveryRecords: 32,
  writeTimeoutMs: 3000,
});
const failure = (code, message) => Object.assign(new Error(message), { code });
const sanitize = (value) =>
  typeof value === 'string'
    ? redactSecrets(value).redactedText
    : Array.isArray(value)
      ? value.map(sanitize)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value).map(([key, item]) => [key, sanitize(item)]),
          )
        : value;

/** One serialized, backpressured writer; partial writes never advance its committed count. */
export class VisibleTraceWriter {
  constructor(handle, options = {}) {
    this.handle = handle;
    this.options = { ...TRACE_LIMITS, ...options };
    this.receivedSequence = 0;
    this.writtenSequence = 0;
    this.durableSequence = 0;
    this.bytesWritten = 0;
    this.writeCalls = 0;
    this.fault = null;
    this.closed = false;
    this.incompleteTailBytes = 0;
    this.writeDurationMs = 0;
    this.syncDurationMs = 0;
  }
  static async create(file, options) {
    return new VisibleTraceWriter(await open(file, 'wx', 0o600), options);
  }
  async perform(operation, code = 'TRACE_IO_TIMEOUT') {
    let timer;
    try {
      return await Promise.race([
        operation(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(failure(code, 'Trace operation exceeded its deadline.')),
            this.options.writeTimeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async write(value, elapsedMs) {
    if (this.fault || this.closed)
      throw this.fault ?? failure('TRACE_CLOSED', 'Trace writer is closed.');
    this.receivedSequence++;
    const started = performance.now();
    try {
      if (this.receivedSequence > this.options.maxRecords)
        throw failure(
          'TRACE_RECORD_LIMIT',
          'Visible trace record limit reached.',
        );
      const record = {
        ...sanitize(value),
        _rirei: {
          schemaVersion: 1,
          sequence: this.receivedSequence,
          elapsedMs,
          receivedAt: new Date().toISOString(),
        },
      };
      const bytes = Buffer.from(JSON.stringify(record) + '\n');
      if (bytes.length > this.options.maxLineBytes)
        throw failure(
          'TRACE_LINE_LIMIT',
          'Visible trace record exceeds the line limit.',
        );
      if (this.bytesWritten + bytes.length > this.options.maxTraceBytes)
        throw failure('TRACE_BYTE_LIMIT', 'Visible trace byte limit reached.');
      let offset = 0;
      while (offset < bytes.length) {
        const result = await this.perform(() =>
          this.handle.write(bytes, offset, bytes.length - offset, null),
        );
        this.writeCalls++;
        if (!result.bytesWritten)
          throw failure('TRACE_SHORT_WRITE', 'Trace write made no progress.');
        offset += result.bytesWritten;
        this.bytesWritten += result.bytesWritten;
      }
      this.writtenSequence = this.receivedSequence;
      if (this.writtenSequence % this.options.syncEveryRecords === 0)
        await this.sync();
      return record;
    } catch (error) {
      this.fault = error;
      throw error;
    } finally {
      this.writeDurationMs += performance.now() - started;
    }
  }
  async sync() {
    const started = performance.now();
    try {
      await this.perform(() => this.handle.sync());
      this.durableSequence = this.writtenSequence;
    } catch (error) {
      this.fault = error;
      throw error;
    } finally {
      this.syncDurationMs += performance.now() - started;
    }
  }
  invalidate(error) {
    this.fault ??= error;
  }
  async close() {
    if (this.closed) return this.status();
    let failure = null;
    try {
      if (!this.fault) await this.sync();
    } catch (error) {
      failure = error;
    }
    this.closed = true;
    try {
      await this.perform(() => this.handle.close());
    } catch (error) {
      this.invalidate(error);
      failure ??= error;
    }
    if (failure) throw failure;
    return this.status();
  }
  status() {
    return {
      receivedSequence: this.receivedSequence,
      writtenSequence: this.writtenSequence,
      durableSequence: this.durableSequence,
      bytesWritten: this.bytesWritten,
      writeCalls: this.writeCalls,
      writeDurationMs: this.writeDurationMs,
      syncDurationMs: this.syncDurationMs,
      incompleteTailBytes: this.incompleteTailBytes,
      complete:
        this.closed &&
        !this.fault &&
        !this.incompleteTailBytes &&
        this.receivedSequence === this.durableSequence,
      errorCode: this.fault?.code ?? null,
    };
  }
}

/** Awaiting each record applies stream backpressure; only one bounded line/chunk is pending. */
export async function consumeVisibleStream(
  stream,
  { writer, select, observe = () => {}, onRecord = async () => {}, clock },
) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  let ignoredLines = 0;
  const accept = async (line) => {
    if (Buffer.byteLength(line) > writer.options.maxLineBytes)
      throw failure(
        'TRACE_LINE_LIMIT',
        'Provider output line exceeds the limit.',
      );
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (/^\s*[[{]/.test(line))
        throw failure('TRACE_INVALID_JSON', 'Provider emitted malformed JSON.');
      if (line.trim()) ignoredLines++;
      return;
    }
    const value = select(parsed);
    if (!value) return;
    const elapsedMs = Math.round(clock() * 1000) / 1000;
    const stored = await writer.write(value, elapsedMs);
    observe(stored, elapsedMs);
    // Capture normalizers perform their own redaction so their source redaction flags stay accurate.
    await writer.perform(() => onRecord(value), 'TRACE_CALLBACK_TIMEOUT');
  };
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
        pending += decoder.decode(bytes.subarray(offset, offset + 64 * 1024), {
          stream: true,
        });
        let newline;
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          await accept(line);
        }
        if (Buffer.byteLength(pending) > writer.options.maxLineBytes)
          throw failure(
            'TRACE_LINE_LIMIT',
            'Unterminated provider output exceeds the limit.',
          );
      }
    }
    pending += decoder.decode();
    // An unterminated JSON tail is not a committed provider event, even if it happens to parse.
    writer.incompleteTailBytes = pending.trim()
      ? Buffer.byteLength(pending)
      : 0;
    return { ignoredLines, incompleteTailBytes: writer.incompleteTailBytes };
  } catch (error) {
    writer.invalidate(error);
    throw error;
  }
}
