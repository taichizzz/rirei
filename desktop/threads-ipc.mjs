import path from 'node:path';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHECKPOINT_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/;
const THREAD_BODY_MAX_BYTES = 8 * 1024;

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function boundedString(value, maxLength, { trim = false } = {}) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength
  )
    return null;
  if (value.includes('\0')) return null;
  const normalized = trim ? value.trim() : value;
  return normalized ? normalized : null;
}

function projectPath(value) {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length < 4096 &&
    !value.includes('\0') &&
    path.isAbsolute(value)
    ? value
    : null;
}

function uuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value : null;
}

function actor(value) {
  if (typeof value !== 'string' || !value.startsWith('run:')) return null;
  const runId = boundedString(value.slice(4), 160, { trim: true });
  return runId && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(runId)
    ? `run:${runId}`
    : null;
}

function operationId(value) {
  return value === undefined ? undefined : uuid(value);
}

function contextIds(value, kind) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 3) return null;
  const parsed = [];
  for (const entry of value) {
    if (typeof entry !== 'string') return null;
    const canonical = entry.startsWith(`${kind}:`)
      ? entry.slice(kind.length + 1)
      : entry;
    if (
      (kind === 'note' && !UUID_PATTERN.test(canonical)) ||
      (kind === 'checkpoint' && !CHECKPOINT_PATTERN.test(canonical))
    )
      return null;
    parsed.push(canonical);
  }
  return parsed;
}

function messageBody(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > THREAD_BODY_MAX_BYTES ||
    !value.trim() ||
    hasUnsafeMessageControl(value)
  )
    return null;
  return value;
}

function hasUnsafeMessageControl(value) {
  for (const character of value) {
    const code = character.codePointAt(0);
    const allowedWhitespace = code === 0x09 || code === 0x0a;
    if (
      (code <= 0x1f && !allowedWhitespace) ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    )
      return true;
  }
  return false;
}

function parseMessageRequest(kind, request) {
  const reply = kind === 'reply';
  const allowed = new Set([
    'project',
    reply ? 'parentMessageId' : 'to',
    'intent',
    'delivery',
    'text',
    'contextNotes',
    'contextCheckpoints',
    'redact',
    'operationId',
  ]);
  if (!isRecord(request) || !hasOnlyKeys(request, allowed)) return null;
  const project = projectPath(request.project);
  const target = reply ? uuid(request.parentMessageId) : actor(request.to);
  const text = messageBody(request.text);
  const intents = reply
    ? new Set(['request', 'inform', 'ack'])
    : new Set(['request', 'inform']);
  const intent = request.intent ?? (reply ? 'inform' : 'request');
  const delivery = request.delivery ?? 'inbox';
  const contextNotes = contextIds(request.contextNotes, 'note');
  const contextCheckpoints = contextIds(
    request.contextCheckpoints,
    'checkpoint',
  );
  const parsedOperationId = operationId(request.operationId);
  if (
    !project ||
    !target ||
    !text ||
    !intents.has(intent) ||
    !['inbox', 'next_safe_turn', 'wake'].includes(delivery) ||
    contextNotes === null ||
    contextCheckpoints === null ||
    contextNotes.length + contextCheckpoints.length > 3 ||
    (request.redact !== undefined && typeof request.redact !== 'boolean') ||
    (request.operationId !== undefined && !parsedOperationId)
  )
    return null;
  return {
    project,
    ...(reply ? { parentMessageId: target } : { to: target }),
    intent,
    delivery,
    text,
    contextNotes,
    contextCheckpoints,
    redact: request.redact === true,
    operationId: parsedOperationId,
  };
}

export function parseThreadsIpcRequest(kind, request) {
  if (kind === 'send' || kind === 'reply')
    return parseMessageRequest(kind, request);
  if (!isRecord(request)) return null;

  if (kind === 'list') {
    if (!hasOnlyKeys(request, new Set(['project', 'filter']))) return null;
    const project = projectPath(request.project);
    const filter =
      request.filter === undefined
        ? undefined
        : boundedString(request.filter, 200, { trim: true });
    if (!project || (request.filter !== undefined && filter === null))
      return null;
    return { project, ...(filter ? { filter } : {}) };
  }

  const idKey = kind === 'thread' ? 'threadId' : 'messageId';
  if (
    !['thread', 'read', 'acknowledge'].includes(kind) ||
    !hasOnlyKeys(request, new Set(['project', idKey]))
  )
    return null;
  const project = projectPath(request.project);
  const id = uuid(request[idKey]);
  return project && id ? { project, [idKey]: id } : null;
}

export function scopeThreadsIpcRequest(kind, request, activeRoot, resolveRoot) {
  const parsed = parseThreadsIpcRequest(kind, request);
  if (!parsed || typeof activeRoot !== 'string') return null;
  const projectRoot = resolveRoot(parsed.project);
  return projectRoot && projectRoot === activeRoot
    ? { ...parsed, projectRoot }
    : null;
}

export const THREADS_STDIN_MAX_BYTES = THREAD_BODY_MAX_BYTES;
