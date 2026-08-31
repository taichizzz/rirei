import { describe, expect, test } from 'vitest';
import {
  deriveProviderReadiness,
  effortsForModel,
  formatExactTimestamp,
  launchProfileOverrides,
  planStatusLabel,
  selectedModelValue,
  usageWindowPresentation,
} from '../../desktop/renderer/provider-ui.mjs';

const catalogEntry = {
  efforts: ['low', 'medium', 'high'],
  models: {
    values: [
      { id: 'fast', efforts: ['low', 'medium'] },
      { id: 'none', efforts: [] },
    ],
  },
};

describe('desktop provider UI contract', () => {
  test('uses model-specific efforts without treating an empty list as missing', () => {
    expect(effortsForModel(catalogEntry, 'fast')).toEqual(['low', 'medium']);
    expect(effortsForModel(catalogEntry, 'none')).toEqual([]);
    expect(effortsForModel(catalogEntry, 'custom/model')).toEqual([
      'low',
      'medium',
      'high',
    ]);
  });

  test('turns custom selections into launch overrides and lets Auto clear a saved profile', () => {
    expect(selectedModelValue('__custom', ' vendor/model-v2 ')).toBe(
      'vendor/model-v2',
    );
    expect(selectedModelValue('__custom', '   ')).toBeUndefined();
    expect(
      launchProfileOverrides(
        { model: 'saved/model', effort: 'high' },
        { model: undefined, effort: undefined },
      ),
    ).toEqual({ model: undefined, effort: undefined });
    expect(
      launchProfileOverrides(
        { model: 'saved/model', effort: 'high' },
        { model: 'session/model', effort: 'low' },
      ),
    ).toEqual({ model: 'session/model', effort: 'low' });
  });

  test('presents stale percentages and arbitrary remaining units explicitly', () => {
    expect(
      usageWindowPresentation({
        remainingPercentage: 38,
        status: 'stale',
      }),
    ).toEqual({
      remaining: 38,
      percent: 38,
      stale: true,
      valueLabel: '38% stale',
    });
    expect(
      usageWindowPresentation({
        remaining: 25,
        limit: 100,
        unit: 'credits',
        status: 'available',
      }),
    ).toEqual({
      remaining: 25,
      percent: 25,
      stale: false,
      valueLabel: '25 credits',
    });
  });

  test('keeps collector failures and unsupported plans distinct', () => {
    expect(
      planStatusLabel({ status: 'error', statusReason: 'collector_error' }),
    ).toBe('Read error');
    expect(
      planStatusLabel({
        status: 'unsupported',
        statusReason: 'unsupported_auth',
      }),
    ).toBe('Authentication-specific');
  });

  test('formats exact timestamps with seconds and a timezone', () => {
    const value = formatExactTimestamp('2026-08-30T12:34:56.000Z', {
      locale: 'en-US',
      timeZone: 'UTC',
    });
    expect(value).toContain('Aug 30, 2026');
    expect(value).toContain('12:34:56 PM');
    expect(value).toContain('UTC');
    expect(formatExactTimestamp('invalid')).toBeNull();
  });

  test('derives missing CLI, sign-in, and unsupported usage onboarding states', () => {
    const readiness = deriveProviderReadiness(
      [
        {
          id: 'claude',
          displayName: 'Claude',
          installed: true,
          version: '1.0.0',
          authentication: { status: 'not_authenticated' },
        },
        {
          id: 'gemini',
          displayName: 'Gemini',
          installed: false,
          version: null,
        },
        {
          id: 'codex',
          displayName: 'Codex',
          installed: false,
          version: null,
          installation: { status: 'error', detail: 'Probe timed out.' },
        },
      ],
      [
        { id: 'claude', statusReason: 'not_collected' },
        { id: 'gemini', statusReason: 'unsupported_auth' },
      ],
    );

    expect(readiness[0]).toMatchObject({
      cli: { label: 'Installed', tone: 'ready' },
      authentication: { label: 'Sign-in required', tone: 'action' },
      usage: { label: 'Not collected yet', tone: 'neutral' },
    });
    expect(readiness[1]).toMatchObject({
      cli: { label: 'CLI missing', tone: 'blocked' },
      authentication: { label: 'Unavailable', tone: 'blocked' },
      usage: { label: 'Account-specific', tone: 'neutral' },
    });
    expect(readiness[2]).toMatchObject({
      cli: {
        label: 'Check failed',
        tone: 'warning',
        detail: 'Probe timed out.',
      },
    });
  });
});
