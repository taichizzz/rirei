import { TextDecoder } from 'node:util';
import path from 'node:path';

export const DAEMON_PROTOCOL_VERSION = 2;
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

export function validThreadProject(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length < 4096 &&
    !value.includes('\0') &&
    path.isAbsolute(value)
  );
}

function exactKeys(value, keys) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}

function hasProtocolControl(value) {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function boundedProtocolString(value, max, optional = false) {
  if (value === undefined) return optional;
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    !hasProtocolControl(value) &&
    !value.startsWith('-')
  );
}

export function validStartRequest(value) {
  const keys = [
    'project',
    'kind',
    'command',
    'agent',
    'workspaceId',
    'branchLabel',
    'model',
    'effort',
    'resumeTargetKind',
    'resumeTargetValue',
    'fork',
    'shell',
    'size',
  ];
  if (!exactKeys(value, keys) || !validThreadProject(value.project))
    return false;
  if (!['agent', 'shell'].includes(value.kind)) return false;
  if (
    value.command !== undefined &&
    !['run', 'switch', 'resume', 'shell'].includes(value.command)
  )
    return false;
  if (
    value.kind === 'agent' &&
    !['claude', 'codex', 'gemini', 'antigravity', 'opencode'].includes(
      value.agent,
    )
  )
    return false;
  if (value.kind === 'shell' && value.agent !== undefined) return false;
  if (!boundedProtocolString(value.workspaceId ?? 'default', 120)) return false;
  if (!boundedProtocolString(value.branchLabel, 255, true)) return false;
  if (!boundedProtocolString(value.model, 255, true)) return false;
  if (!boundedProtocolString(value.effort, 120, true)) return false;
  if (!boundedProtocolString(value.shell, 4096, true)) return false;
  if (
    value.resumeTargetKind !== undefined &&
    !['latest', 'picker', 'id'].includes(value.resumeTargetKind)
  )
    return false;
  if (!boundedProtocolString(value.resumeTargetValue, 512, true)) return false;
  if (value.fork !== undefined && typeof value.fork !== 'boolean') return false;
  if (value.size !== undefined) {
    if (!exactKeys(value.size, ['cols', 'rows'])) return false;
    if (
      !Number.isInteger(value.size.cols) ||
      value.size.cols < 1 ||
      value.size.cols > 10_000 ||
      !Number.isInteger(value.size.rows) ||
      value.size.rows < 1 ||
      value.size.rows > 10_000
    )
      return false;
  }
  return true;
}

export function validThreadWatch(value) {
  return (
    exactKeys(value, ['projectRoot', 'enabled']) &&
    validThreadProject(value.projectRoot) &&
    typeof value.enabled === 'boolean'
  );
}

export function validThreadNotification(value) {
  return (
    exactKeys(value, [
      'projectRoot',
      'sessionId',
      'threadId',
      'messageId',
      'revision',
    ]) &&
    validThreadProject(value.projectRoot) &&
    (value.sessionId === undefined ||
      (typeof value.sessionId === 'string' &&
        value.sessionId.length > 0 &&
        value.sessionId.length <= 160 &&
        !hasProtocolControl(value.sessionId))) &&
    (value.threadId === undefined || validTerminalId(value.threadId)) &&
    (value.messageId === undefined || validTerminalId(value.messageId)) &&
    (value.revision === undefined ||
      (Number.isSafeInteger(value.revision) && value.revision >= 0))
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
