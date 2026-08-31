import { describe, expect, it } from 'vitest';
import { exactUsageTimestamp, runtimeLabel } from '../../src/tui/app.js';

describe('TUI presentation helpers', () => {
  it('normalizes rounded runtime values across minute boundaries', () => {
    expect(runtimeLabel(59.4)).toBe('59s');
    expect(runtimeLabel(59.6)).toBe('1m 0s');
    expect(runtimeLabel(119.6)).toBe('2m 0s');
  });

  it('formats exact provider timestamps as canonical UTC', () => {
    expect(exactUsageTimestamp('2026-08-30T12:34:56.000Z')).toBe(
      '2026-08-30T12:34:56Z',
    );
    expect(exactUsageTimestamp(null)).toBe('not reported');
    expect(exactUsageTimestamp('invalid')).toBe('invalid timestamp');
  });
});
