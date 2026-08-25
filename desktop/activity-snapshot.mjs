import { open } from 'node:fs/promises';

const MAX_FILE_BYTES = 512_000;
const MAX_SESSIONS = 128;
const MAX_STRING = 160;
const AGENTS = new Set([
  'claude',
  'codex',
  'gemini',
  'antigravity',
  'opencode',
]);
const ROLES = new Set(['implement', 'review', 'verify', 'investigate']);
const STATUSES = new Set([
  'starting',
  'working',
  'waiting',
  'needs_attention',
  'completed',
  'cancelled',
  'failed',
  'orphaned',
]);
const LIFECYCLE_STATES = new Set([
  'starting',
  'working',
  'needs_permission',
  'waiting_for_input',
  'stopping',
  'completed',
  'cancelled',
  'failed',
  'orphaned',
]);
const ATTENTION_KINDS = new Set(['permission', 'input', 'unknown']);

function exactKeys(value, required, optional = []) {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => allowed.has(key))
  );
}

function boundedString(value) {
  return (
    typeof value === 'string' && value.length >= 1 && value.length <= MAX_STRING
  );
}

function isoDate(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function validUsageMetric(usage) {
  return (
    usage &&
    typeof usage === 'object' &&
    !Array.isArray(usage) &&
    exactKeys(
      usage,
      ['id', 'kind', 'unit', 'status', 'statusReason'],
      ['window', 'used', 'remaining', 'limit', 'resetsAt'],
    ) &&
    boundedString(usage.id) &&
    ['quota', 'requests', 'tokens', 'credits', 'cost'].includes(usage.kind) &&
    ['percent', 'requests', 'tokens', 'credits', 'currency'].includes(
      usage.unit,
    ) &&
    ['available', 'stale'].includes(usage.status) &&
    ['live', 'sample_stale', 'window_expired', 'invalid_capture'].includes(
      usage.statusReason,
    ) &&
    (usage.window === undefined ||
      (usage.window &&
        typeof usage.window === 'object' &&
        exactKeys(usage.window, ['label'], ['durationSeconds']) &&
        boundedString(usage.window.label) &&
        (usage.window.durationSeconds === undefined ||
          (Number.isInteger(usage.window.durationSeconds) &&
            usage.window.durationSeconds > 0)))) &&
    ['used', 'remaining', 'limit'].every(
      (key) =>
        usage[key] === undefined ||
        (typeof usage[key] === 'number' && Number.isFinite(usage[key])),
    ) &&
    (usage.resetsAt === undefined || isoDate(usage.resetsAt))
  );
}

function validSession(session, schemaVersion) {
  const runtimeRequired = schemaVersion >= 2;
  const lifecycleRequired = schemaVersion >= 3;
  return (
    session &&
    typeof session === 'object' &&
    !Array.isArray(session) &&
    exactKeys(
      session,
      [
        'id',
        'runId',
        'workspaceId',
        'agent',
        'projectLabel',
        'taskLabel',
        'branchLabel',
        'role',
        'status',
        'startedAt',
        'updatedAt',
        'needsAttention',
        ...(lifecycleRequired ? ['lifecycleState'] : []),
      ],
      [
        'message',
        'usage',
        'activeRuntimeSeconds',
        ...(lifecycleRequired ? ['attentionKind'] : []),
      ],
    ) &&
    boundedString(session.id) &&
    boundedString(session.runId) &&
    boundedString(session.workspaceId) &&
    AGENTS.has(session.agent) &&
    boundedString(session.projectLabel) &&
    boundedString(session.taskLabel) &&
    boundedString(session.branchLabel) &&
    ROLES.has(session.role) &&
    STATUSES.has(session.status) &&
    (!lifecycleRequired || LIFECYCLE_STATES.has(session.lifecycleState)) &&
    (session.attentionKind === undefined ||
      ATTENTION_KINDS.has(session.attentionKind)) &&
    (session.message === undefined || boundedString(session.message)) &&
    isoDate(session.startedAt) &&
    isoDate(session.updatedAt) &&
    (!runtimeRequired || Object.hasOwn(session, 'activeRuntimeSeconds')) &&
    (session.activeRuntimeSeconds === undefined ||
      (typeof session.activeRuntimeSeconds === 'number' &&
        Number.isFinite(session.activeRuntimeSeconds) &&
        session.activeRuntimeSeconds >= 0)) &&
    typeof session.needsAttention === 'boolean' &&
    (session.usage === undefined ||
      (Array.isArray(session.usage) &&
        session.usage.length <= 16 &&
        session.usage.every(validUsageMetric)))
  );
}

export function validateActivitySnapshot(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, [
      'schemaVersion',
      'instanceId',
      'updatedAt',
      'sessions',
    ]) ||
    ![1, 2, 3].includes(value.schemaVersion) ||
    !boundedString(value.instanceId) ||
    !isoDate(value.updatedAt) ||
    !Array.isArray(value.sessions) ||
    value.sessions.length > MAX_SESSIONS ||
    !value.sessions.every((session) =>
      validSession(session, value.schemaVersion),
    )
  )
    return null;
  return JSON.parse(JSON.stringify(value));
}

export async function readValidatedActivitySnapshot(file) {
  let handle;
  try {
    handle = await open(file, 'r');
    const details = await handle.stat();
    if (!details.isFile() || details.size > MAX_FILE_BYTES)
      throw new Error('The Rirei activity snapshot is invalid or too large.');
    const parsed = JSON.parse(await handle.readFile('utf8'));
    const snapshot = validateActivitySnapshot(parsed);
    if (!snapshot) throw new Error('The Rirei activity snapshot is invalid.');
    return snapshot;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  } finally {
    await handle?.close();
  }
}
