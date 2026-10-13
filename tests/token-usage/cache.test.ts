import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hostname } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { safeTokenUsageError } from '../../src/cli/usage.js';
import { rireiDataHome } from '../../src/platform/runtime-paths.js';
import { RelayLockError } from '../../src/state/lock.js';
import {
  assertPrivacySafe,
  TokenUsagePrivacyError,
} from '../../src/token-usage/privacy.js';
import {
  getCachedTokenUsage,
  readDiskCache,
  writeDiskCache,
} from '../../src/token-usage/cache.js';
import { CcusageSource } from '../../src/token-usage/ccusage.js';
import type {
  AgentCacheSnapshot,
  AgentId,
  TokenUsageCache,
} from '../../src/token-usage/schema.js';

const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeTmpDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  directories.push(dir);
  // Isolate the data root even when LOCALAPPDATA or XDG_DATA_HOME is set.
  vi.stubEnv('RIREI_DATA_HOME', path.join(dir, 'data'));
  return dir;
}

function createMockSnapshot(
  agentId: AgentId,
  totalTokens: number,
  capturedAt: string,
): AgentCacheSnapshot {
  return {
    agentId,
    capturedAt,
    status: 'available',
    coverage: { complete: true, earliestDate: '2026-03-29' },
    totalTokens,
    itemized: true,
    daily: [
      { date: '2026-09-24', totalTokens },
      { date: '2026-09-01', totalTokens: 1000 },
    ],
    models: [{ model: 'test-model', totalTokens }],
    sessions: [],
    sessionCount: 0,
  };
}

describe('token usage cache, locking, and failure preservation', () => {
  it('atomically writes and reads disk cache', async () => {
    const home = await makeTmpDir('rirei-cache-test-');
    const dataDir = rireiDataHome({ home });
    const now = new Date('2026-09-24T12:00:00Z');

    const cache: TokenUsageCache = {
      schemaVersion: 1,
      timezone: 'UTC',
      updatedAt: now.toISOString(),
      agents: {
        claude: createMockSnapshot('claude', 500000, now.toISOString()),
        codex: undefined,
        gemini: undefined,
        antigravity: undefined,
        opencode: undefined,
      },
    };

    await writeDiskCache(dataDir, cache);
    const read = await readDiskCache(dataDir);
    expect(read).not.toBeNull();
    expect(read?.agents.claude?.totalTokens).toBe(500000);
  });

  it('preserves the last good snapshot when a refresh fails', async () => {
    const home = await makeTmpDir('rirei-cache-preserve-');
    const dataDir = rireiDataHome({ home });
    const now = new Date('2026-09-24T12:00:00Z');

    // Initial good snapshot in cache (captured earlier)
    const earlier = new Date(now.getTime() - 60_000).toISOString();
    const initialCache: TokenUsageCache = {
      schemaVersion: 1,
      timezone: 'UTC',
      updatedAt: earlier,
      agents: {
        claude: createMockSnapshot('claude', 1000000, earlier),
        codex: undefined,
        gemini: undefined,
        antigravity: undefined,
        opencode: undefined,
      },
    };
    await writeDiskCache(dataDir, initialCache);

    // Mock source that returns an error snapshot (e.g. timed_out)
    class FailingSource extends CcusageSource {
      override async collectAgentSnapshot(agentId: AgentId) {
        return {
          agentId,
          capturedAt: new Date().toISOString(),
          status: 'error' as const,
          errorCode: 'timed_out' as const,
          errorReason: 'Timed out after 30s',
          coverage: { complete: false, earliestDate: null },
          totalTokens: null,
          itemized: false,
          daily: [],
          models: [],
          sessions: [],
          sessionCount: null,
        };
      }
    }

    const report = await getCachedTokenUsage({
      home,
      timezone: 'UTC',
      forceRefresh: true,
      agent: 'claude',
      source: new FailingSource(),
      now,
    });

    // Kept the last good data!
    expect(report.agents.find((a) => a.id === 'claude')?.totalTokens).toBe(
      1001000,
    );
    // Recorded error beside it
    expect(report.agents.find((a) => a.id === 'claude')?.errorCode).toBe(
      'timed_out',
    );
  });

  it('deduplicates concurrent scans across single-flight lock to one scan per agent', async () => {
    const home = await makeTmpDir('rirei-cache-lock-');
    const now = new Date('2026-09-24T12:00:00Z');

    let scanCount = 0;
    class CountingSource extends CcusageSource {
      override async collectAgentSnapshot(agentId: AgentId) {
        scanCount++;
        // Simulate asynchronous scan work
        await new Promise((r) => setTimeout(r, 60));
        return createMockSnapshot(agentId, 777, now.toISOString());
      }
    }

    const source = new CountingSource();

    // Two concurrent calls for the same agent
    const [res1, res2] = await Promise.all([
      getCachedTokenUsage({
        home,
        forceRefresh: true,
        agent: 'claude',
        source,
        now,
      }),
      getCachedTokenUsage({
        home,
        forceRefresh: true,
        agent: 'claude',
        source,
        now,
      }),
    ]);

    expect(res1.totals?.totalTokens).toBe(res2.totals?.totalTokens);
    // Exactly one scan occurred
    expect(scanCount).toBe(1);
  });

  it('switches range without triggering any subprocess scan', async () => {
    const home = await makeTmpDir('rirei-cache-range-');
    const now = new Date('2026-09-24T12:00:00Z');

    const cache: TokenUsageCache = {
      schemaVersion: 1,
      timezone: 'UTC',
      updatedAt: now.toISOString(),
      agents: {
        claude: createMockSnapshot('claude', 500000, now.toISOString()),
        codex: undefined,
        gemini: undefined,
        antigravity: undefined,
        opencode: undefined,
      },
    };
    await writeDiskCache(rireiDataHome({ home }), cache);

    // Call getCachedTokenUsage with forceRefresh: false across different ranges
    const rep7 = await getCachedTokenUsage({
      home,
      timezone: 'UTC',
      days: 7,
      now,
    });
    const rep30 = await getCachedTokenUsage({
      home,
      timezone: 'UTC',
      days: 30,
      now,
    });
    const rep90 = await getCachedTokenUsage({
      home,
      timezone: 'UTC',
      days: 90,
      now,
    });
    expect(rep7.totals?.totalTokens).toBe(500000);

    expect(rep7.range.days).toBe(7);
    expect(rep30.range.days).toBe(30);
    expect(rep90.range.days).toBe(90);
  });

  it('waits for a competing scan longer than the old two-second limit', async () => {
    const home = await makeTmpDir('rirei-cache-wait-');
    const now = new Date('2026-09-24T12:00:00Z');

    let scanCount = 0;
    class SlowSource extends CcusageSource {
      override async collectAgentSnapshot(agentId: AgentId) {
        scanCount++;
        await new Promise((r) => setTimeout(r, 2600));
        return createMockSnapshot(agentId, 4242, now.toISOString());
      }
    }
    const source = new SlowSource();
    const request = () =>
      getCachedTokenUsage({
        home,
        timezone: 'UTC',
        forceRefresh: true,
        agent: 'antigravity',
        source,
        now,
      });

    const [first, second] = await Promise.all([request(), request()]);
    expect(scanCount).toBe(1);
    // 4242 on the scan day plus the mock's 1000-token day
    expect(first.totals?.totalTokens).toBe(5242);
    expect(second.totals?.totalTokens).toBe(5242);
  }, 15_000);

  it('keeps the last good snapshot when another refresh outlasts the wait', async () => {
    const home = await makeTmpDir('rirei-cache-busy-');
    const dataDir = rireiDataHome({ home });
    const now = new Date('2026-09-24T12:00:00Z');
    const earlier = new Date(now.getTime() - 60_000).toISOString();
    await writeDiskCache(dataDir, {
      schemaVersion: 1,
      timezone: 'UTC',
      updatedAt: earlier,
      agents: {
        claude: createMockSnapshot('claude', 900, earlier),
        codex: undefined,
        gemini: undefined,
        antigravity: undefined,
        opencode: undefined,
      },
    });
    // A live holder (this process) keeps the claude scan lock.
    const lock = path.join(dataDir, 'token-usage-claude.lock');
    await mkdir(lock, { recursive: true });
    await writeFile(
      path.join(lock, 'owner.json'),
      JSON.stringify({
        token: 'held',
        pid: process.pid,
        host: hostname(),
        acquiredAt: now.toISOString(),
      }),
    );

    let scanned = false;
    class NeverSource extends CcusageSource {
      override async collectAgentSnapshot(agentId: AgentId) {
        scanned = true;
        return createMockSnapshot(agentId, 1, now.toISOString());
      }
    }

    const report = await getCachedTokenUsage({
      home,
      timezone: 'UTC',
      forceRefresh: true,
      agent: 'claude',
      source: new NeverSource(),
      now,
      lockWaitMs: 150,
    });
    expect(scanned).toBe(false);
    expect(report.agents.find((a) => a.id === 'claude')?.totalTokens).toBe(
      1900,
    );
  });

  it('never relabels daily totals collected in another timezone', async () => {
    const home = await makeTmpDir('rirei-cache-zone-');
    const dataDir = rireiDataHome({ home });
    const now = new Date('2026-09-24T12:00:00Z');
    await writeDiskCache(dataDir, {
      schemaVersion: 1,
      timezone: 'UTC',
      updatedAt: now.toISOString(),
      agents: {
        claude: createMockSnapshot('claude', 100, now.toISOString()),
        codex: createMockSnapshot('codex', 50, now.toISOString()),
        gemini: undefined,
        antigravity: undefined,
        opencode: undefined,
      },
    });

    const read = await getCachedTokenUsage({
      home,
      timezone: 'Pacific/Honolulu',
      now,
    });
    // Unusable, so the dashboard rescans instead of showing shifted days
    expect(read.totals).toBeNull();
    expect(read.agents.find((a) => a.id === 'claude')?.freshness).toBe(
      'missing',
    );

    class ZoneSource extends CcusageSource {
      override async collectAgentSnapshot(agentId: AgentId) {
        return createMockSnapshot(agentId, 7, now.toISOString());
      }
    }
    await getCachedTokenUsage({
      home,
      timezone: 'Pacific/Honolulu',
      forceRefresh: true,
      agent: 'claude',
      source: new ZoneSource(),
      now,
    });
    const stored = await readDiskCache(dataDir);
    expect(stored?.timezone).toBe('Pacific/Honolulu');
    expect(stored?.agents.claude?.totalTokens).toBe(7);
    // The UTC codex snapshot was dropped, not mixed in
    expect(stored?.agents.codex).toBeUndefined();
  });

  it('keeps paths and usernames out of token usage errors', () => {
    const lockError = new RelayLockError(
      'Another Relay process is holding the token-usage-claude lock. Wait for it to finish, or remove /Users/someone/Library/Application Support/Rirei/token-usage-claude.lock if no Relay is running.',
    );
    const safe = safeTokenUsageError(lockError).message;
    expect(safe).not.toMatch(/[\\/]/);
    expect(safe).toContain('still running');

    const user = process.env.USER ?? process.env.USERNAME;
    if (user && user.length >= 2) {
      let caught: unknown;
      try {
        assertPrivacySafe({ label: `project-of-${user}` });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(TokenUsagePrivacyError);
      expect((caught as Error).message.toLowerCase()).not.toContain(
        user.toLowerCase(),
      );
    }
    expect(safeTokenUsageError(new Error('/private/path')).message).toBe(
      'Token usage could not be read.',
    );
  });
});
