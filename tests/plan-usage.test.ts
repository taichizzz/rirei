import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
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
      .map((directory) => rm(directory, { recursive: true })),
  );
});

describe('provider plan usage', () => {
  it('creates a Claude-only status-line collector without storing status payloads', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'relay-plan-usage-'));
    directories.push(root);
    await mkdir(path.join(root, '.relay'));
    const settingsPath = await prepareProviderUsage(root, 'claude');
    expect(settingsPath).toBe(
      path.join(root, '.relay', 'runtime', 'claude-settings.json'),
    );
    const settings = JSON.parse(await readFile(settingsPath!, 'utf8')) as {
      statusLine: { command: string };
    };
    expect(settings.statusLine.command).toContain('claude-usage.cjs');
    await expect(prepareProviderUsage(root, 'codex')).resolves.toBeUndefined();
  });

  it('reports remaining Claude windows and leaves unsupported providers unknown', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'relay-plan-usage-'));
    directories.push(root);
    await mkdir(path.join(root, '.relay', 'provider-usage'), {
      recursive: true,
    });
    await writeFile(
      path.join(root, '.relay', 'provider-usage', 'claude.json'),
      JSON.stringify({
        provider: 'claude',
        capturedAt: '2026-07-13T00:00:00.000Z',
        fiveHour: { usedPercentage: 25, resetsAt: 1783904400 },
        week: { usedPercentage: 60 },
      }),
    );
    const emptyCodexHome = await mkdtemp(path.join(tmpdir(), 'codex-none-'));
    directories.push(emptyCodexHome);
    const plans = await readProviderPlanUsage(root, {
      codexHome: emptyCodexHome,
      now: new Date('2026-07-13T00:05:00.000Z'),
    });
    expect(plans.find((plan) => plan.id === 'claude')).toMatchObject({
      status: 'available',
      fiveHour: { usedPercentage: 25, remainingPercentage: 75 },
      week: { usedPercentage: 60, remainingPercentage: 40 },
    });
    expect(plans.find((plan) => plan.id === 'codex')).toMatchObject({
      status: 'unknown',
    });
    expect(plans.find((plan) => plan.id === 'antigravity')).toMatchObject({
      status: 'unknown',
    });
  });

  it('marks old provider data stale without hiding its values', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'relay-plan-usage-'));
    directories.push(root);
    await mkdir(path.join(root, '.relay', 'provider-usage'), {
      recursive: true,
    });
    await writeFile(
      path.join(root, '.relay', 'provider-usage', 'claude.json'),
      JSON.stringify({
        provider: 'claude',
        capturedAt: '2026-07-13T00:00:00.000Z',
        fiveHour: { usedPercentage: 25, resetsAt: 1783990800 },
      }),
    );
    const emptyCodexHome = await mkdtemp(path.join(tmpdir(), 'codex-none-'));
    directories.push(emptyCodexHome);
    const plans = await readProviderPlanUsage(root, {
      codexHome: emptyCodexHome,
      now: new Date('2026-07-13T00:16:00.000Z'),
    });
    expect(plans.find((plan) => plan.id === 'claude')).toMatchObject({
      status: 'stale',
      fiveHour: { remainingPercentage: 75 },
    });
  });

  it('runs the generated collector and stores only sanitized Claude fields', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'relay-plan-usage-'));
    directories.push(root);
    await mkdir(path.join(root, '.relay'));
    await prepareProviderUsage(root, 'claude');
    const collector = path.join(root, '.relay', 'runtime', 'claude-usage.cjs');
    const child = execFileAsync(process.execPath, [collector]);
    child.child.stdin?.end(
      JSON.stringify({
        session_id: 'abc',
        transcript_path: '/secret/transcript.jsonl',
        rate_limits: {
          five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
          seven_day: { used_percentage: 41.2, resets_at: 1738857600 },
        },
      }),
    );
    await child;
    const stored = JSON.parse(
      await readFile(
        path.join(root, '.relay', 'provider-usage', 'claude.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    expect(stored).toMatchObject({
      provider: 'claude',
      fiveHour: { usedPercentage: 23.5, resetsAt: 1738425600 },
      week: { usedPercentage: 41.2, resetsAt: 1738857600 },
    });
    expect(Object.keys(stored).sort()).toEqual([
      'capturedAt',
      'fiveHour',
      'provider',
      'week',
    ]);
  });
});

function rolloutLine(rateLimits: unknown, timestamp: string): string {
  return JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: { type: 'token_count', rate_limits: rateLimits },
  });
}

describe('readCodexPlanUsage', () => {
  it('maps the newest rollout rate limits onto plan windows', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'codex-home-'));
    directories.push(home);
    const day = path.join(home, 'sessions', '2026', '07', '13');
    await mkdir(day, { recursive: true });
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

  it('returns null without sessions, without rate limits, or with bad percentages', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'codex-none-'));
    directories.push(empty);
    expect(await readCodexPlanUsage(empty)).toBeNull();
    const day = path.join(empty, 'sessions', '2026', '01', '01');
    await mkdir(day, { recursive: true });
    await writeFile(
      path.join(day, 'rollout-2026-01-01T00-00-00-bbb.jsonl'),
      `${rolloutLine({ primary: { used_percent: 250, window_minutes: 300 } }, 't')}\n`,
    );
    expect(await readCodexPlanUsage(empty)).toBeNull();
  });
});
