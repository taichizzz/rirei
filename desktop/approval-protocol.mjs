import { randomBytes, timingSafeEqual } from 'node:crypto';

export const APPROVAL_PROTOCOL_VERSION = 1;
export const APPROVAL_REQUEST_LIMIT = 32;
export const APPROVAL_DETAIL_LIMIT = 8;
export const APPROVAL_MAX_LIFETIME_MS = 5 * 60 * 1000;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const PROVIDERS = new Set(['claude', 'codex', 'gemini']);
const CATEGORIES = new Set([
  'tool_use',
  'command',
  'file_change',
  'network',
  'other',
]);
const DECISIONS = new Set(['allow_once', 'deny']);

function exactKeys(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => allowed.has(key))
  );
}

function safeText(value, maximum) {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= maximum &&
    Array.from(value).every((character) => {
      const code = character.charCodeAt(0);
      return (
        code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)
      );
    })
  );
}

function isoDate(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function validateApprovalRequest(value) {
  if (
    !exactKeys(value, [
      'schemaVersion',
      'requestId',
      'terminalId',
      'provider',
      'category',
      'title',
      'details',
      'createdAt',
      'expiresAt',
      'decisions',
    ]) ||
    value.schemaVersion !== APPROVAL_PROTOCOL_VERSION ||
    !UUID.test(value.requestId) ||
    !UUID.test(value.terminalId) ||
    !PROVIDERS.has(value.provider) ||
    !CATEGORIES.has(value.category) ||
    !safeText(value.title, 160) ||
    !Array.isArray(value.details) ||
    value.details.length > APPROVAL_DETAIL_LIMIT ||
    !value.details.every(
      (detail) =>
        exactKeys(detail, ['label', 'value']) &&
        safeText(detail.label, 48) &&
        safeText(detail.value, 512),
    ) ||
    !isoDate(value.createdAt) ||
    !isoDate(value.expiresAt) ||
    !Array.isArray(value.decisions) ||
    value.decisions.length !== 2 ||
    value.decisions[0] !== 'allow_once' ||
    value.decisions[1] !== 'deny'
  )
    return null;
  const createdAt = Date.parse(value.createdAt);
  const expiresAt = Date.parse(value.expiresAt);
  if (
    expiresAt <= createdAt ||
    expiresAt - createdAt > APPROVAL_MAX_LIFETIME_MS
  )
    return null;
  return clone(value);
}

export function validateApprovalDecision(value) {
  if (
    !exactKeys(value, [
      'schemaVersion',
      'requestId',
      'terminalId',
      'decision',
    ]) ||
    value.schemaVersion !== APPROVAL_PROTOCOL_VERSION ||
    !UUID.test(value.requestId) ||
    !UUID.test(value.terminalId) ||
    !DECISIONS.has(value.decision)
  )
    return null;
  return clone(value);
}

export function validateApprovalChannelDescriptor(value) {
  if (
    !exactKeys(value, [
      'schemaVersion',
      'baseURL',
      'token',
      'pid',
      'startedAt',
    ]) ||
    value.schemaVersion !== APPROVAL_PROTOCOL_VERSION ||
    typeof value.baseURL !== 'string' ||
    !/^http:\/\/127\.0\.0\.1:(?:[1-9]\d{0,4})$/.test(value.baseURL) ||
    Number(new URL(value.baseURL).port) > 65535 ||
    !TOKEN.test(value.token) ||
    !Number.isInteger(value.pid) ||
    value.pid <= 0 ||
    !isoDate(value.startedAt)
  )
    return null;
  return clone(value);
}

export function createApprovalChannelToken() {
  return randomBytes(32).toString('base64url');
}

export function authorizationHeaderMatches(value, token) {
  if (!TOKEN.test(token) || typeof value !== 'string') return false;
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(value);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class ApprovalRequestStore {
  constructor(limit = APPROVAL_REQUEST_LIMIT) {
    if (!Number.isInteger(limit) || limit < 1 || limit > APPROVAL_REQUEST_LIMIT)
      throw new Error('Invalid approval request limit.');
    this.limit = limit;
    this.pending = new Map();
  }

  add(value, now = Date.now()) {
    const request = validateApprovalRequest(value);
    if (!request || Date.parse(request.expiresAt) <= now)
      throw new Error('Invalid or expired approval request.');
    this.expire(now);
    if (this.pending.has(request.requestId))
      throw new Error('Duplicate approval request.');
    if (this.pending.size >= this.limit)
      throw new Error('Approval request limit reached.');
    this.pending.set(request.requestId, request);
    return clone(request);
  }

  list(now = Date.now()) {
    this.expire(now);
    return [...this.pending.values()]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(clone);
  }

  resolve(value, now = Date.now()) {
    const decision = validateApprovalDecision(value);
    if (!decision) return null;
    this.expire(now);
    const request = this.pending.get(decision.requestId);
    if (!request || request.terminalId !== decision.terminalId) return null;
    this.pending.delete(decision.requestId);
    return { request: clone(request), decision: clone(decision) };
  }

  cancelTerminal(terminalId) {
    if (!UUID.test(terminalId)) return 0;
    let removed = 0;
    for (const [requestId, request] of this.pending) {
      if (request.terminalId !== terminalId) continue;
      this.pending.delete(requestId);
      removed += 1;
    }
    return removed;
  }

  expire(now = Date.now()) {
    let removed = 0;
    for (const [requestId, request] of this.pending) {
      if (Date.parse(request.expiresAt) > now) continue;
      this.pending.delete(requestId);
      removed += 1;
    }
    return removed;
  }
}
