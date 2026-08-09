import { describe, expect, test } from 'vitest';
import {
  APPROVAL_MAX_LIFETIME_MS,
  APPROVAL_PROTOCOL_VERSION,
  ApprovalRequestStore,
  authorizationHeaderMatches,
  createApprovalChannelToken,
  validateApprovalChannelDescriptor,
  validateApprovalDecision,
  validateApprovalRequest,
} from '../../desktop/approval-protocol.mjs';

const requestId = '123e4567-e89b-12d3-a456-426614174000';
const terminalId = '123e4567-e89b-42d3-a456-426614174001';
const now = Date.parse('2026-08-09T00:00:00.000Z');

function request(overrides = {}) {
  return {
    schemaVersion: APPROVAL_PROTOCOL_VERSION,
    requestId,
    terminalId,
    provider: 'claude',
    category: 'command',
    title: 'Claude requests permission',
    details: [{ label: 'Command', value: 'npm test' }],
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    decisions: ['allow_once', 'deny'],
    ...overrides,
  };
}

function decision(overrides = {}) {
  return {
    schemaVersion: APPROVAL_PROTOCOL_VERSION,
    requestId,
    terminalId,
    decision: 'allow_once',
    ...overrides,
  };
}

describe('approval protocol', () => {
  test('accepts and clones exact bounded requests and decisions', () => {
    const source = request();
    expect(validateApprovalRequest(source)).toEqual(source);
    expect(validateApprovalRequest(source)).not.toBe(source);
    expect(validateApprovalDecision(decision())).toEqual(decision());
  });

  test.each([
    { provider: 'antigravity' },
    { category: 'shell' },
    { decisions: ['deny', 'allow_once'] },
    { decisions: ['allow_always', 'deny'] },
    { title: '\u001b[31mspoofed' },
    { details: [{ label: 'x', value: 'x'.repeat(513) }] },
    { extra: true },
    { expiresAt: new Date(now).toISOString() },
    {
      expiresAt: new Date(now + APPROVAL_MAX_LIFETIME_MS + 1).toISOString(),
    },
  ])('rejects unsafe request variation %#', (overrides) => {
    expect(validateApprovalRequest(request(overrides))).toBeNull();
  });

  test('rejects malformed, persistent, and cross-request decisions', () => {
    expect(
      validateApprovalDecision(decision({ decision: 'allow_always' })),
    ).toBeNull();
    expect(
      validateApprovalDecision(decision({ command: 'npm test' })),
    ).toBeNull();
    expect(
      validateApprovalDecision(decision({ requestId: 'not-a-uuid' })),
    ).toBeNull();
  });

  test('accepts only an exact loopback channel descriptor', () => {
    const descriptor = {
      schemaVersion: APPROVAL_PROTOCOL_VERSION,
      baseURL: 'http://127.0.0.1:4711',
      token: createApprovalChannelToken(),
      pid: 42,
      startedAt: new Date(now).toISOString(),
    };
    expect(validateApprovalChannelDescriptor(descriptor)).toEqual(descriptor);
    expect(
      validateApprovalChannelDescriptor({
        ...descriptor,
        baseURL: 'http://localhost:4711',
      }),
    ).toBeNull();
    expect(
      validateApprovalChannelDescriptor({
        ...descriptor,
        baseURL: 'http://0.0.0.0:4711',
      }),
    ).toBeNull();
    expect(
      validateApprovalChannelDescriptor({
        ...descriptor,
        baseURL: 'https://127.0.0.1:4711',
      }),
    ).toBeNull();
  });

  test('creates fixed-size tokens and compares bearer headers', () => {
    const token = createApprovalChannelToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorizationHeaderMatches(`Bearer ${token}`, token)).toBe(true);
    expect(authorizationHeaderMatches(token, token)).toBe(false);
    expect(authorizationHeaderMatches(`Bearer ${token}x`, token)).toBe(false);
  });

  test('binds one-shot decisions to request and terminal ownership', () => {
    const store = new ApprovalRequestStore();
    store.add(request(), now);
    expect(
      store.resolve(
        decision({ terminalId: '123e4567-e89b-42d3-a456-426614174099' }),
        now,
      ),
    ).toBeNull();
    expect(store.list(now)).toHaveLength(1);
    expect(store.resolve(decision(), now)).toEqual({
      request: request(),
      decision: decision(),
    });
    expect(store.resolve(decision(), now)).toBeNull();
  });

  test('expires requests, cancels terminal ownership, and bounds the queue', () => {
    const store = new ApprovalRequestStore(1);
    store.add(request(), now);
    expect(() =>
      store.add(
        request({ requestId: '123e4567-e89b-42d3-a456-426614174002' }),
        now,
      ),
    ).toThrow(/limit/);
    expect(store.cancelTerminal(terminalId)).toBe(1);
    store.add(request(), now);
    expect(store.list(now + 60_000)).toEqual([]);
    expect(store.resolve(decision(), now + 60_000)).toBeNull();
  });

  test('rejects duplicate and already-expired requests', () => {
    const store = new ApprovalRequestStore();
    store.add(request(), now);
    expect(() => store.add(request(), now)).toThrow(/Duplicate/);
    expect(() => store.add(request(), now + 60_000)).toThrow(/expired/);
  });
});
