import { describe, expect, it } from 'vitest';
import { createUsageAlertPolicy } from '../../desktop/usage-alert-policy.mjs';

type WindowName = 'fiveHour' | 'week';

function snapshot({
  provider = 'claude',
  window = 'fiveHour',
  remaining,
  capturedAt = '2026-07-21T10:00:00.000Z',
  resetsAt = '2026-07-21T15:00:00.000Z',
  planStatus = 'available',
  windowStatus = 'available',
}: {
  provider?: string;
  window?: WindowName;
  remaining: number;
  capturedAt?: string;
  resetsAt?: string | null;
  planStatus?: string;
  windowStatus?: string;
}) {
  return {
    plans: [
      {
        id: provider,
        status: planStatus,
        capturedAt,
        [window]: {
          remainingPercentage: remaining,
          resetsAt,
          status: windowStatus,
        },
      },
    ],
  };
}

describe('desktop usage alert policy', () => {
  it('alerts at the 20 and 5 percent thresholds', () => {
    const policy = createUsageAlertPolicy();
    expect(policy.evaluate('/project', snapshot({ remaining: 20 }))).toEqual([
      { provider: 'claude', window: 'fiveHour', threshold: 20 },
    ]);
    expect(
      policy.evaluate(
        '/project',
        snapshot({ remaining: 5, capturedAt: '2026-07-21T10:01:00.000Z' }),
      ),
    ).toEqual([{ provider: 'claude', window: 'fiveHour', threshold: 5 }]);
  });

  it('alerts once at the most severe threshold for a first low sample', () => {
    const policy = createUsageAlertPolicy();
    expect(policy.evaluate('/project', snapshot({ remaining: 4 }))).toEqual([
      { provider: 'claude', window: 'fiveHour', threshold: 5 },
    ]);
  });

  it('ignores stale and unknown usage', () => {
    const policy = createUsageAlertPolicy();
    expect(
      policy.evaluate(
        '/project',
        snapshot({ remaining: 4, planStatus: 'stale' }),
      ),
    ).toEqual([]);
    expect(
      policy.evaluate(
        '/project',
        snapshot({
          remaining: 4,
          capturedAt: '2026-07-21T10:01:00.000Z',
          windowStatus: 'stale',
        }),
      ),
    ).toEqual([]);
    expect(
      policy.evaluate(
        '/project',
        snapshot({
          remaining: 4,
          capturedAt: '2026-07-21T10:02:00.000Z',
          planStatus: 'unknown',
        }),
      ),
    ).toEqual([]);
  });

  it('does not repeat a threshold in the same reset cycle', () => {
    const policy = createUsageAlertPolicy();
    expect(
      policy.evaluate('/project', snapshot({ remaining: 19 })),
    ).toHaveLength(1);
    expect(
      policy.evaluate(
        '/project',
        snapshot({ remaining: 18, capturedAt: '2026-07-21T10:01:00.000Z' }),
      ),
    ).toEqual([]);
  });

  it('re-arms thresholds when the reset advances', () => {
    const policy = createUsageAlertPolicy();
    policy.evaluate('/project', snapshot({ remaining: 4 }));
    expect(
      policy.evaluate(
        '/project',
        snapshot({
          remaining: 4,
          capturedAt: '2026-07-21T10:01:00.000Z',
          resetsAt: '2026-07-22T15:00:00.000Z',
        }),
      ),
    ).toEqual([{ provider: 'claude', window: 'fiveHour', threshold: 5 }]);
  });

  it('ignores out-of-order samples', () => {
    const policy = createUsageAlertPolicy();
    policy.evaluate(
      '/project',
      snapshot({ remaining: 50, capturedAt: '2026-07-21T10:02:00.000Z' }),
    );
    expect(
      policy.evaluate(
        '/project',
        snapshot({ remaining: 4, capturedAt: '2026-07-21T10:01:00.000Z' }),
      ),
    ).toEqual([]);
    expect(
      policy.evaluate(
        '/project',
        snapshot({
          window: 'week',
          remaining: 4,
          capturedAt: '2026-07-21T10:01:30.000Z',
        }),
      ),
    ).toEqual([]);
    expect(
      policy.evaluate(
        '/project',
        snapshot({ remaining: 4, capturedAt: '2026-07-21T10:03:00.000Z' }),
      ),
    ).toHaveLength(1);
  });

  it('tracks providers and windows independently', () => {
    const policy = createUsageAlertPolicy();
    const combined = {
      plans: [
        {
          ...snapshot({ remaining: 19 }).plans[0],
          week: {
            remainingPercentage: 4,
            resetsAt: '2026-07-28T15:00:00.000Z',
            status: 'available',
          },
        },
        snapshot({ provider: 'codex', remaining: 5 }).plans[0],
      ],
    };
    expect(policy.evaluate('/project', combined)).toEqual([
      { provider: 'claude', window: 'fiveHour', threshold: 20 },
      { provider: 'claude', window: 'week', threshold: 5 },
      { provider: 'codex', window: 'fiveHour', threshold: 5 },
    ]);
  });
});
