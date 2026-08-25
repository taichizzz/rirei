import { TextDecoder } from 'node:util';

export const DAEMON_PROTOCOL_VERSION = 1;
export const DAEMON_MAX_FRAME_BYTES = 128 * 1024;
export const DAEMON_MAX_IO_BYTES = 64 * 1024;

export function encodeDaemonFrame(frame) {
  return `${JSON.stringify({ v: DAEMON_PROTOCOL_VERSION, ...frame })}\n`;
}

export class DaemonFrameDecoder {
  constructor(maxBytes = DAEMON_MAX_FRAME_BYTES) {
    this.maxBytes = maxBytes;
    this.buffer = Buffer.alloc(0);
    this.textDecoder = new TextDecoder('utf-8', { fatal: true });
  }

  push(chunk) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.buffer = Buffer.concat([this.buffer, data]);
    const frames = [];
    while (this.buffer.includes(0x0a)) {
      const offset = this.buffer.indexOf(0x0a);
      const line = this.buffer.subarray(0, offset);
      this.buffer = this.buffer.subarray(offset + 1);
      if (line.length > this.maxBytes) {
        this.buffer = Buffer.alloc(0);
        throw new Error('Daemon protocol frame exceeds the size limit.');
      }
      const text = this.textDecoder.decode(line);
      if (!text.trim()) continue;
      const frame = JSON.parse(text);
      if (!frame || frame.v !== DAEMON_PROTOCOL_VERSION)
        throw new Error('Unsupported daemon protocol version.');
      frames.push(frame);
    }
    if (this.buffer.length > this.maxBytes) {
      this.buffer = Buffer.alloc(0);
      throw new Error('Daemon protocol frame exceeds the size limit.');
    }
    return frames;
  }
}

export function validTerminalId(value) {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
  );
}

export function validCursor(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function validSize(value, fallback = { cols: 80, rows: 24 }) {
  const valid = (number) =>
    Number.isInteger(number) && number >= 1 && number <= 10_000;
  return {
    cols: valid(value?.cols) ? value.cols : fallback.cols,
    rows: valid(value?.rows) ? value.rows : fallback.rows,
  };
}

export function publicDaemonError(code, message) {
  return { code, message };
}
