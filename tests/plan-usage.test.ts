import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLAUDE_USAGE_INPUT_MAX_BYTES,
  CODEX_ROLLOUT_FILE_LIMIT,
  CODEX_ROLLOUT_TAIL_MAX_BYTES,
  claudeProviderUsagePath,
  prepareProviderUsage,
  readCodexPlanUsage,
  readProviderPlanUsage,
} from '../src/plan-usage.js';

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

async function projectAndHome(): Promise<{ root: string; home: string }> {
  const root = await temporaryDirectory('relay-plan-usage-');
  const home = await temporaryDirectory('relay-plan-home-');
  await mkdir(path.join(root, '.relay'));
  return { root, home };
}

async function runCollector(
  collector: string,
  input: unknown | string,
): Promise<void> {
  const child = execFileAsync(process.execPath, [collector]);
  child.child.stdin?.end(
    typeof input === 'string' ? input : JSON.stringify(input),
  );
  await child;
}

function claudePayload(usedPercentage: number): Record<string, unknown> {
  return {
    session_id: 'must-not-be-stored',
    transcript_path: '/secret/transcript.jsonl',
    prompt: 'must not be stored',
    rate_limits: {
      five_hour: { used_percentage: usedPercentage, resets_at: 1784488616 },
      seven_day: { used_percentage: 41.2, resets_at: 1784918400 },
    },
  };
}

function epoch(iso: string): number {
  return Date.parse(iso) / 1000;
}

describe('provider plan usage', () => {
  it('creates project-local runtime files targeting the global secure cache', async () => {
    const { root, home } = await projectAndHome();
    const settingsPath = await prepareProviderUsage(root, 'claude', { home });
    expect(settingsPath).toBe(
      path.join(root, '.relay', 'runtime', 'claude-settings.json'),
    );
    const settings = JSON.parse(await readFile(settingsPath!, 'utf8')) as {
      statusLine: { command: string; refreshInterval?: number };
    };
    expect(settings.statusLine.command).toContain('claude-usage.cjs');
    expect(settings.statusLine.refreshInterval).toBeUndefined();
    expect(await stat(path.dirname(settingsPath!))).toMatchObject({
      mode: 0o40700,
    });
    expect(claudeProviderUsagePath({ home })).toBe(
      path.join(home, '.relay', 'provider-usage', 'claude.json'),
    );
    await expect(
      prepareProviderUsage(root, 'codex', { home }),
    ).resolves.toBeUndefined();
  });

  it('prefers the global Claude sample and falls back read-only to the project sample', async () => {
    const { root, home } = await projectAndHome();
    const localPath = path.join(
      root,
      '.relay',
      'provider-usage',
      'claude.json',
    );
    const globalPath = claudeProviderUsagePath({ home });
    await mkdir(path.dirname(localPath), { recursive: true });
    await writeFile(
      localPath,
      JSON.stringify({
        provider: 'claude',
        capturedAt: '2026-07-13T00:00:00.000Z',
        fiveHour: { usedPercentage: 25 },
      }),
    );
    const emptyCodexHome = await temporaryDirectory('codex-none-');
    let plans = await readProviderPlanUsage(root, {
      home,
      codexHome: emptyCodexHome,
      now: new Date('2026-07-13T00:05:00.000Z'),
    });
    expect(plans.find((plan) => plan.id === 'claude')).toMatchObject({
      status: 'available',
      fiveHour: { usedPercentage: 25, remainingPercentage: 75 },
    });
    await expect(stat(path.dirname(globalPath))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    await mkdir(path.dirname(globalPath), { recursive: true });
    await writeFile(
      globalPath,
      JSON.stringify({
        provider: 'claude',
        capturedAt: '2026-07-13T00:04:00.000Z',
        fiveHour: { usedPercentage: 70 },
      }),
    );
    plans = await readProviderPlanUsage(root, {
      home,
      codexHome: emptyCodexHome,
      now: new Date('2026-07-13T00:05:00.000Z'),
    });
    expect(plans.find((plan) => plan.id === 'claude')?.fiveHour).toMatchObject({
      usedPercentage: 70,
    });
  });

  it('tracks freshness per window and keeps the provider available with one live window', async () => {
    const { root, home } = await projectAndHome();
    const globalPath = claudeProviderUsagePath({ home });
    await mkdir(path.dirname(globalPath), { recursive: true });
    await writeFile(
      globalPath,
      JSON.stringify({
        provider: 'claude',
        capturedAt: '2026-07-13T00:04:00.000Z',
        fiveHour: {
          usedPercentage: 100,
          resetsAt: epoch('2026-07-13T00:03:00.000Z'),
        },
        week: {
          usedPercentage: 60,
          resetsAt: epoch('2026-07-14T00:00:00.000Z'),
        },
      }),
    );
    const emptyCodexHome = await temporaryDirectory('codex-none-');
    const plans = await readProviderPlanUsage(root, {
      home,
      codexHome: emptyCodexHome,
      now: new Date('2026-07-13T00:05:00.000Z'),
    });
    expect(plans.find((plan) => plan.id === 'claude')).toMatchObject({
      status: 'available',
      statusReason: 'live_window',
      fiveHour: { status: 'stale', statusReason: 'window_expired' },
      week: { status: 'available', statusReason: 'live' },
    });
  });

  it('marks all old windows stale without hiding their values', async () => {
    const { root, home } = await projectAndHome();
    const globalPath = claudeProviderUsagePath({ home });
    await mkdir(path.dirname(globalPath), { recursive: true });
    await writeFile(
      globalPath,
      JSON.stringify({
        provider: 'claude',
        capturedAt: '2026-07-13T00:00:00.000Z',
        fiveHour: { usedPercentage: 25, resetsAt: 1783990800 },
      }),
    );
    const emptyCodexHome = await temporaryDirectory('codex-none-');
    const plans = await readProviderPlanUsage(root, {
      home,
      codexHome: emptyCodexHome,
      now: new Date('2026-07-13T00:16:00.000Z'),
    });
    expect(plans.find((plan) => plan.id === 'claude')).toMatchObject({
      status: 'stale',
      statusReason: 'all_windows_stale',
      fiveHour: {
        remainingPercentage: 75,
        status: 'stale',
        statusReason: 'sample_stale',
      },
    });
  });

  it('stores only sanitized Claude fields in the global cache', async () => {
    const { root, home } = await projectAndHome();
    await prepareProviderUsage(root, 'claude', { home });
    const collector = path.join(root, '.relay', 'runtime', 'claude-usage.cjs');
    await runCollector(collector, claudePayload(23.5));
    const outputPath = claudeProviderUsagePath({ home });
    const stored = JSON.parse(await readFile(outputPath, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(stored).toMatchObject({
      provider: 'claude',
      fiveHour: { usedPercentage: 23.5, resetsAt: 1784488616 },
      week: { usedPercentage: 41.2, resetsAt: 1784918400 },
    });
    expect(Object.keys(stored).sort()).toEqual([
      'capturedAt',
      'fiveHour',
      'provider',
      'week',
    ]);
    expect(await readFile(outputPath, 'utf8')).not.toMatch(
      /session|transcript|prompt|secret/,
    );
    expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(outputPath))).mode & 0o777).toBe(0o700);
  });

  it('clamps numeric percentages and rejects nonnumeric fields and invalid resets', async () => {
    const { root, home } = await projectAndHome();
    await prepareProviderUsage(root, 'claude', { home });
    const collector = path.join(root, '.relay', 'runtime', 'claude-usage.cjs');
    await runCollector(collector, {
      rate_limits: {
        five_hour: {
          used_percentage: -5,
          resets_at: Number.MAX_SAFE_INTEGER,
        },
        seven_day: { used_percentage: '20', resets_at: 1784918400 },
      },
    });
    const stored = JSON.parse(
      await readFile(claudeProviderUsagePath({ home }), 'utf8'),
    ) as Record<string, unknown>;
    expect(stored).toMatchObject({
      fiveHour: { usedPercentage: 0 },
    });
    expect(stored).not.toHaveProperty('fiveHour.resetsAt');
    expect(stored).not.toHaveProperty('week');
  });

  it('does not refresh unchanged Claude values but updates changed values', async () => {
    const { root, home } = await projectAndHome();
    await prepareProviderUsage(root, 'claude', { home });
    const collector = path.join(root, '.relay', 'runtime', 'claude-usage.cjs');
    const outputPath = claudeProviderUsagePath({ home });
    await runCollector(collector, claudePayload(20));
    const first = JSON.parse(await readFile(outputPath, 'utf8')) as {
      capturedAt: string;
      fiveHour: { usedPercentage: number };
    };
    await new Promise((resolve) => setTimeout(resolve, 20));
    await runCollector(collector, claudePayload(20));
    const unchanged = JSON.parse(await readFile(outputPath, 'utf8')) as {
      capturedAt: string;
    };
    expect(unchanged.capturedAt).toBe(first.capturedAt);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await runCollector(collector, claudePayload(21));
    const changed = JSON.parse(await readFile(outputPath, 'utf8')) as {
      capturedAt: string;
      fiveHour: { usedPercentage: number };
    };
    expect(changed.capturedAt).not.toBe(first.capturedAt);
    expect(changed.fiveHour.usedPercentage).toBe(21);
  });

  it('refreshes an old unchanged Claude observation before it becomes stale', async () => {
    const { root, home } = await projectAndHome();
    await prepareProviderUsage(root, 'claude', { home });
    const collector = path.join(root, '.relay', 'runtime', 'claude-usage.cjs');
    const outputPath = claudeProviderUsagePath({ home });
    await mkdir(path.dirname(outputPath), { recursive: true });
    const oldCapture = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    await writeFile(
      outputPath,
      JSON.stringify({
        provider: 'claude',
        capturedAt: oldCapture,
        fiveHour: { usedPercentage: 20, resetsAt: 1784488616 },
        week: { usedPercentage: 41.2, resetsAt: 1784918400 },
      }),
      { mode: 0o600 },
    );

    await runCollector(collector, claudePayload(20));

    const refreshed = JSON.parse(await readFile(outputPath, 'utf8')) as {
      capturedAt: string;
      fiveHour: { usedPercentage: number };
    };
    expect(refreshed.capturedAt).not.toBe(oldCapture);
    expect(refreshed.fiveHour.usedPercentage).toBe(20);
  });

  it('rejects oversized input without writing a sample', async () => {
    const { root, home } = await projectAndHome();
    await prepareProviderUsage(root, 'claude', { home });
    const collector = path.join(root, '.relay', 'runtime', 'claude-usage.cjs');
    const oversized = JSON.stringify({
      ...claudePayload(20),
      padding: 'x'.repeat(CLAUDE_USAGE_INPUT_MAX_BYTES),
    });
    await runCollector(collector, oversized);
    await expect(
      readFile(claudeProviderUsagePath({ home })),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses unique temporary files during concurrent collector runs', async () => {
    const { root, home } = await projectAndHome();
    await prepareProviderUsage(root, 'claude', { home });
    const collector = path.join(root, '.relay', 'runtime', 'claude-usage.cjs');
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        runCollector(collector, claudePayload(10 + index)),
      ),
    );
    const outputPath = claudeProviderUsagePath({ home });
    const stored = JSON.parse(await readFile(outputPath, 'utf8')) as {
      fiveHour: { usedPercentage: number };
    };
    expect(stored.fiveHour.usedPercentage).toBeGreaterThanOrEqual(10);
    expect(stored.fiveHour.usedPercentage).toBeLessThanOrEqual(17);
    expect(await readdir(path.dirname(outputPath))).toEqual(['claude.json']);
  });
});

function rolloutLine(rateLimits: unknown, timestamp: string): string {
  return JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: { type: 'token_count', rate_limits: rateLimits },
  });
}

async function rolloutDirectory(home: string): Promise<string> {
  const day = path.join(home, 'sessions', '2026', '07', '13');
  await mkdir(day, { recursive: true });
  return day;
}

describe('readCodexPlanUsage', () => {
  it('maps exact expected durations from the newest matching record', async () => {
    const home = await temporaryDirectory('codex-home-');
    const day = await rolloutDirectory(home);
    await writeFile(
      path.join(day, 'rollout-2026-07-13T11-31-33-aaa.jsonl'),
      [
        JSON.stringify({ timestamp: 't0', type: 'session_meta', payload: {} }),
        rolloutLine(
          {
            primary: {
              used_percent: 10,
              window_minutes: 10080,
              resets_at: 1784488616,
            },
            secondary: {
              used_percent: 42.5,
              window_minutes: 300,
              resets_at: 1784400000,
            },
            plan_type: 'plus',
          },
          '2026-07-13T03:31:57.264Z',
        ),
      ].join('\n'),
    );
    const usage = await readCodexPlanUsage(home);
    expect(usage).toMatchObject({
      capturedAt: '2026-07-13T03:31:57.264Z',
      planType: 'plus',
      week: { usedPercentage: 10, remainingPercentage: 90 },
      fiveHour: { usedPercentage: 42.5, remainingPercentage: 57.5 },
    });
    expect(usage?.week?.resetsAt).toBe(
      new Date(1784488616 * 1000).toISOString(),
    );
  });

  it('does not guess unknown window durations', async () => {
    const home = await temporaryDirectory('codex-home-');
    const day = await rolloutDirectory(home);
    await writeFile(
      path.join(day, 'rollout-2026-07-13T11-31-33-aaa.jsonl'),
      `${rolloutLine(
        {
          primary: { used_percent: 10, window_minutes: 301 },
          secondary: { used_percent: 20, window_minutes: 10079 },
        },
        '2026-07-13T03:31:57.264Z',
      )}\n`,
    );
    await expect(readCodexPlanUsage(home)).resolves.toBeNull();
  });

  it('skips malformed timestamps, resets, and non-matching records', async () => {
    const home = await temporaryDirectory('codex-home-');
    const day = await rolloutDirectory(home);
    await writeFile(
      path.join(day, 'rollout-2026-07-13T11-31-33-aaa.jsonl'),
      [
        rolloutLine(
          {
            primary: {
              used_percent: 10,
              window_minutes: 300,
              resets_at: Number.MAX_SAFE_INTEGER,
            },
          },
          '2026-07-13T03:30:00.000Z',
        ),
        rolloutLine(
          { primary: { used_percent: 20, window_minutes: 300 } },
          'not-a-time',
        ),
        JSON.stringify({
          timestamp: '2026-07-13T03:32:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            rate_limits: {
              primary: { used_percent: 99, window_minutes: 300 },
            },
          },
        }),
      ].join('\n'),
    );
    const usage = await readCodexPlanUsage(home);
    expect(usage).toMatchObject({
      capturedAt: '2026-07-13T03:30:00.000Z',
      fiveHour: { usedPercentage: 10, resetsAt: null },
    });
  });

  it('reads only the bounded tail of rollout files', async () => {
    const home = await temporaryDirectory('codex-home-');
    const day = await rolloutDirectory(home);
    const oldRecord = rolloutLine(
      { primary: { used_percent: 10, window_minutes: 300 } },
      '2026-07-13T03:30:00.000Z',
    );
    await writeFile(
      path.join(day, 'rollout-2026-07-13T11-31-33-aaa.jsonl'),
      `${oldRecord}\n${'x'.repeat(CODEX_ROLLOUT_TAIL_MAX_BYTES + 100)}`,
    );
    await expect(readCodexPlanUsage(home)).resolves.toBeNull();
  });

  it('inspects only a bounded number of newest rollout files', async () => {
    const home = await temporaryDirectory('codex-home-');
    const day = await rolloutDirectory(home);
    await writeFile(
      path.join(day, 'rollout-2026-07-13T00-00-00-old.jsonl'),
      rolloutLine(
        { primary: { used_percent: 10, window_minutes: 300 } },
        '2026-07-13T00:00:00.000Z',
      ),
    );
    await Promise.all(
      Array.from({ length: CODEX_ROLLOUT_FILE_LIMIT }, (_, index) =>
        writeFile(
          path.join(day, `rollout-2026-07-13T1${index}-00-00-new.jsonl`),
          '{"type":"session_meta"}\n',
        ),
      ),
    );
    await expect(readCodexPlanUsage(home)).resolves.toBeNull();
  });

  it('returns null without sessions or with invalid percentages', async () => {
    const empty = await temporaryDirectory('codex-none-');
    expect(await readCodexPlanUsage(empty)).toBeNull();
    const day = await rolloutDirectory(empty);
    await writeFile(
      path.join(day, 'rollout-2026-01-01T00-00-00-bbb.jsonl'),
      `${rolloutLine(
        { primary: { used_percent: 250, window_minutes: 300 } },
        '2026-01-01T00:00:00.000Z',
      )}\n`,
    );
    expect(await readCodexPlanUsage(empty)).toBeNull();
  });
});
