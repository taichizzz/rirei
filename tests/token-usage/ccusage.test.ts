import {
  execFile,
  type ChildProcess,
  type ExecFileException,
} from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CcusageSource } from '../../src/token-usage/ccusage.js';
import { assertPrivacySafe } from '../../src/token-usage/privacy.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

afterEach(() => vi.resetAllMocks());

function mockExecution(
  error: ExecFileException | null,
  stdout = '',
  stderr = '',
) {
  const end = vi.fn();
  vi.mocked(execFile).mockImplementationOnce((...args: unknown[]) => {
    const callback = args[3] as (
      error: ExecFileException | null,
      stdout: string,
      stderr: string,
    ) => void;
    queueMicrotask(() => callback(error, stdout, stderr));
    return { stdin: { end } } as unknown as ChildProcess;
  });
  return end;
}

describe('CcusageSource error mapping and privacy isolation', () => {
  it('maps missing binary to binary_unavailable without leaking paths', async () => {
    const source = new CcusageSource({
      binaryPath: '/path/does/not/exist/ccusage',
    });
    const snap = await source.collectAgentSnapshot('claude', {
      timezone: 'UTC',
    });

    expect(snap.status).toBe('error');
    expect(snap.errorCode).toBe('binary_unavailable');
    expect(snap.errorReason).toBe('ccusage native binary not found');
    expect(snap.totalTokens).toBeNull();
    // Privacy guard verification on error
    expect(() => assertPrivacySafe(snap)).not.toThrow();
  });

  it('maps non-zero exit codes to nonzero_exit with sanitized message', async () => {
    mockExecution(
      Object.assign(new Error(`Command failed: ${process.execPath}`), {
        code: 42,
      }),
      '',
      'PRIVATE_SESSION_TEXT',
    );
    const source = new CcusageSource({ binaryPath: process.execPath });
    const snap = await source.collectAgentSnapshot('claude', {
      timezone: 'UTC',
    });

    expect(snap.status).toBe('error');
    expect(snap.errorCode).toBe('nonzero_exit');
    expect(snap.errorReason).toContain('exited with code 42');
    // Absolute paths must not leak in errorReason
    expect(snap.errorReason).not.toContain(process.execPath);
    expect(JSON.stringify(snap)).not.toContain('PRIVATE_SESSION_TEXT');
    expect(() => assertPrivacySafe(snap)).not.toThrow();
  });

  it('maps malformed JSON output to invalid_output', async () => {
    mockExecution(null, 'not a valid json output');
    const source = new CcusageSource({ binaryPath: process.execPath });
    const snap = await source.collectAgentSnapshot('claude', {
      timezone: 'UTC',
    });

    expect(snap.status).toBe('error');
    expect(snap.errorCode).toBe('invalid_output');
    expect(snap.errorReason).toBe('Failed to parse ccusage JSON');
    expect(() => assertPrivacySafe(snap)).not.toThrow();
  });

  it('maps invalid schema JSON to invalid_output', async () => {
    mockExecution(null, '{"unexpected": 123}');
    const source = new CcusageSource({ binaryPath: process.execPath });
    const snap = await source.collectAgentSnapshot('codex', {
      timezone: 'UTC',
    });

    expect(snap.status).toBe('error');
    expect(snap.errorCode).toBe('invalid_output');
    expect(snap.errorReason).toBe('ccusage returned invalid output');
    expect(() => assertPrivacySafe(snap)).not.toThrow();
  });

  it('uses explicit offline JSON arguments and closes stdin for both reports', async () => {
    const dailyEnd = mockExecution(
      null,
      '{"daily":[],"totals":{"totalTokens":0}}',
    );
    const sessionEnd = mockExecution(
      null,
      '{"sessions":[],"totals":{"totalTokens":0}}',
    );
    const source = new CcusageSource({ binaryPath: process.execPath });
    const snap = await source.collectAgentSnapshot('claude', {
      timezone: 'UTC',
      now: new Date('2026-10-13T12:00:00Z'),
    });

    expect(snap.status).toBe('available');
    expect(execFile).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(execFile).mock.calls) {
      expect(call[0]).toBe(process.execPath);
      expect(call[1]).toEqual(
        expect.arrayContaining([
          'claude',
          '--json',
          '--offline',
          '--no-cost',
          '--timezone',
          'UTC',
          '--config',
        ]),
      );
    }
    expect(vi.mocked(execFile).mock.calls[0]?.[1]).toContain('daily');
    expect(vi.mocked(execFile).mock.calls[1]?.[1]).toContain('session');
    expect(dailyEnd).toHaveBeenCalledOnce();
    expect(sessionEnd).toHaveBeenCalledOnce();
  });
});
