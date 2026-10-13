import { mkdir, mkdtemp, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  codexReadUsage,
  readCodexUsageRaw,
} from '../../src/agents/usage-collectors.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeTmpDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  directories.push(dir);
  return dir;
}

function rolloutLine(rateLimits: unknown, timestamp: string): string {
  return JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: { type: 'token_count', rate_limits: rateLimits },
  });
}

describe('Codex rollout collector (sessions + archived_sessions)', () => {
  it('reads from active sessions directory when archived_sessions does not exist', async () => {
    const codexHome = await makeTmpDir('codex-active-');
    const activeDir = path.join(codexHome, 'sessions', '2026', '09', '20');
    await mkdir(activeDir, { recursive: true });

    await writeFile(
      path.join(activeDir, 'rollout-active-1.jsonl'),
      [
        rolloutLine(
          {
            primary: { used_percent: 15, window_minutes: 300 },
            secondary: { used_percent: 30, window_minutes: 10080 },
            plan_type: 'plus',
          },
          '2026-09-20T10:00:00.000Z',
        ),
      ].join('\n'),
    );

    const record = await readCodexUsageRaw({ codexHome });
    expect(record).not.toBeNull();
    expect(record?.capturedAt).toBe('2026-09-20T10:00:00.000Z');
    expect(record?.planType).toBe('plus');
    expect(record?.windows).toHaveLength(2);
  });

  it('reads from archived_sessions directory when sessions does not exist', async () => {
    const codexHome = await makeTmpDir('codex-archived-');
    const archivedDir = path.join(
      codexHome,
      'archived_sessions',
      '2026',
      '09',
      '20',
    );
    await mkdir(archivedDir, { recursive: true });

    await writeFile(
      path.join(archivedDir, 'rollout-archived-1.jsonl'),
      [
        rolloutLine(
          {
            primary: { used_percent: 45, window_minutes: 300 },
            plan_type: 'pro',
          },
          '2026-09-20T12:00:00.000Z',
        ),
      ].join('\n'),
    );

    const record = await readCodexUsageRaw({ codexHome });
    expect(record).not.toBeNull();
    expect(record?.capturedAt).toBe('2026-09-20T12:00:00.000Z');
    expect(record?.planType).toBe('pro');
  });

  it('selects the newest record across both sessions and archived_sessions by capture timestamp', async () => {
    const codexHome = await makeTmpDir('codex-both-');
    const activeDir = path.join(codexHome, 'sessions', '2026', '09', '21');
    const archivedDir = path.join(
      codexHome,
      'archived_sessions',
      '2026',
      '09',
      '21',
    );
    await mkdir(activeDir, { recursive: true });
    await mkdir(archivedDir, { recursive: true });

    const olderActiveFile = path.join(activeDir, 'rollout-older.jsonl');
    const newerArchivedFile = path.join(archivedDir, 'rollout-newer.jsonl');

    // Older capture timestamp in active session
    await writeFile(
      olderActiveFile,
      rolloutLine(
        { primary: { used_percent: 10, window_minutes: 300 } },
        '2026-09-21T08:00:00.000Z',
      ),
    );

    // Newer capture timestamp in archived session, but set file mtime artificially older
    await writeFile(
      newerArchivedFile,
      rolloutLine(
        { primary: { used_percent: 75, window_minutes: 300 } },
        '2026-09-21T14:30:00.000Z',
      ),
    );

    // Give olderActiveFile a newer file mtime to verify we don't pick based on mtime
    const pastTime = new Date('2026-01-01T00:00:00Z');
    await utimes(newerArchivedFile, pastTime, pastTime);

    const record = await readCodexUsageRaw({ codexHome });
    expect(record).not.toBeNull();
    expect(record?.capturedAt).toBe('2026-09-21T14:30:00.000Z');
    expect(record?.windows[0]?.usedPercent).toBe(75);
  });

  it('deduplicates duplicate rollout filenames safely', async () => {
    const codexHome = await makeTmpDir('codex-dedup-');
    const activeDir = path.join(codexHome, 'sessions', 'sub');
    const archivedDir = path.join(codexHome, 'archived_sessions', 'sub');
    await mkdir(activeDir, { recursive: true });
    await mkdir(archivedDir, { recursive: true });

    const duplicateName = 'rollout-shared-id.jsonl';
    await writeFile(
      path.join(activeDir, duplicateName),
      rolloutLine(
        { primary: { used_percent: 20, window_minutes: 300 } },
        '2026-09-21T10:00:00.000Z',
      ),
    );
    await writeFile(
      path.join(archivedDir, duplicateName),
      rolloutLine(
        { primary: { used_percent: 20, window_minutes: 300 } },
        '2026-09-21T10:00:00.000Z',
      ),
    );

    const now = new Date('2026-09-21T10:05:00.000Z');
    const snapshots = await codexReadUsage({ codexHome, now });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.status).toBe('available');
    expect(snapshots[0]?.metrics[0]?.used).toBe(20);
  });

  it('keeps the newer active copy when an older archived copy shares its filename', async () => {
    const codexHome = await makeTmpDir('codex-dup-newest-');
    const activeDir = path.join(codexHome, 'sessions', '2026', '09', '21');
    const archivedDir = path.join(codexHome, 'archived_sessions');
    await mkdir(activeDir, { recursive: true });
    await mkdir(archivedDir, { recursive: true });

    const name = 'rollout-shared-id.jsonl';
    await writeFile(
      path.join(activeDir, name),
      rolloutLine(
        { primary: { used_percent: 20, window_minutes: 300 } },
        '2026-09-21T10:00:00.000Z',
      ),
    );
    await writeFile(
      path.join(archivedDir, name),
      rolloutLine(
        { primary: { used_percent: 99, window_minutes: 300 } },
        '2026-09-20T10:00:00.000Z',
      ),
    );

    const now = new Date('2026-09-21T10:05:00.000Z');
    const snapshots = await codexReadUsage({ codexHome, now });
    expect(snapshots[0]?.capturedAt).toBe('2026-09-21T10:00:00.000Z');
    expect(snapshots[0]?.metrics[0]?.used).toBe(20);
  });

  it('falls back to the other copy when one duplicate is unreadable', async () => {
    const codexHome = await makeTmpDir('codex-dup-fallback-');
    const activeDir = path.join(codexHome, 'sessions');
    const archivedDir = path.join(codexHome, 'archived_sessions');
    await mkdir(activeDir, { recursive: true });
    await mkdir(archivedDir, { recursive: true });

    const name = 'rollout-shared-id.jsonl';
    await writeFile(path.join(activeDir, name), '{ not json\n');
    await writeFile(
      path.join(archivedDir, name),
      rolloutLine(
        { primary: { used_percent: 45, window_minutes: 300 } },
        '2026-09-21T09:00:00.000Z',
      ),
    );

    const record = await readCodexUsageRaw({ codexHome });
    expect(record?.windows[0]?.usedPercent).toBe(45);
  });

  it('ignores malformed JSON and lines without rate_limits', async () => {
    const codexHome = await makeTmpDir('codex-malformed-');
    const dir = path.join(codexHome, 'sessions');
    await mkdir(dir, { recursive: true });

    await writeFile(
      path.join(dir, 'rollout-corrupt.jsonl'),
      [
        '{ corrupt json',
        '{"timestamp": "2026-09-22T01:00:00.000Z", "type": "heartbeat"}',
        '{"timestamp": "2026-09-22T02:00:00.000Z", "type": "event_msg", "payload": {"type": "other"}}',
        rolloutLine(
          { primary: { used_percent: 33, window_minutes: 300 } },
          '2026-09-22T03:00:00.000Z',
        ),
      ].join('\n'),
    );

    const record = await readCodexUsageRaw({ codexHome });
    expect(record).not.toBeNull();
    expect(record?.capturedAt).toBe('2026-09-22T03:00:00.000Z');
    expect(record?.windows[0]?.usedPercent).toBe(33);
  });

  it('marks snapshots stale when capture time exceeds stale threshold', async () => {
    const codexHome = await makeTmpDir('codex-stale-');
    const dir = path.join(codexHome, 'sessions');
    await mkdir(dir, { recursive: true });

    await writeFile(
      path.join(dir, 'rollout-stale.jsonl'),
      rolloutLine(
        { primary: { used_percent: 50, window_minutes: 300 } },
        '2026-09-20T00:00:00.000Z',
      ),
    );

    const now = new Date('2026-09-22T00:00:00.000Z'); // 48h later
    const snapshots = await codexReadUsage({
      codexHome,
      now,
      staleAfterMs: 60 * 60 * 1000, // 1 hour threshold
    });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.status).toBe('stale');
    expect(snapshots[0]?.metrics[0]?.status).toBe('stale');
  });
});
