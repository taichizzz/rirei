import { open } from 'node:fs/promises';

const MAX_FILE_BYTES = 512_000;
const MAX_SESSIONS = 128;
const MAX_STRING = 160;
const AGENTS = new Set(['claude', 'codex', 'gemini', 'antigravity']);
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

function validUsage(usage) {
  return (
    usage &&
    typeof usage === 'object' &&
    !Array.isArray(usage) &&
    exactKeys(usage, ['window', 'remainingPercentage', 'resetsAt', 'fresh']) &&
    ['five_hour', 'week'].includes(usage.window) &&
    typeof usage.remainingPercentage === 'number' &&
    Number.isFinite(usage.remainingPercentage) &&
    usage.remainingPercentage >= 0 &&
    usage.remainingPercentage <= 100 &&
    (usage.resetsAt === null || isoDate(usage.resetsAt)) &&
    typeof usage.fresh === 'boolean'
  );
}

function validSession(session) {
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
      ],
      ['message', 'usage'],
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
    (session.message === undefined || boundedString(session.message)) &&
    isoDate(session.startedAt) &&
    isoDate(session.updatedAt) &&
    typeof session.needsAttention === 'boolean' &&
    (session.usage === undefined || validUsage(session.usage))
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
    value.schemaVersion !== 1 ||
    !boundedString(value.instanceId) ||
    !isoDate(value.updatedAt) ||
    !Array.isArray(value.sessions) ||
    value.sessions.length > MAX_SESSIONS ||
    !value.sessions.every(validSession)
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
