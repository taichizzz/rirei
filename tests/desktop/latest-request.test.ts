import { describe, expect, test } from 'vitest';
import { LatestRequestGate } from '../../desktop/renderer/latest-request.mjs';

describe('LatestRequestGate', () => {
  test('accepts only the latest response for the current scope', () => {
    const gate = new LatestRequestGate();
    const first = gate.issue('project-a\0thread-a');
    const second = gate.issue('project-a\0thread-b');

    expect(gate.accepts(first)).toBe(false);
    expect(gate.accepts(second, 'project-a\0thread-b')).toBe(true);
    expect(gate.accepts(second, 'project-b\0thread-b')).toBe(false);
  });

  test('invalidates in-flight work when a modal closes', () => {
    const gate = new LatestRequestGate();
    const request = gate.issue('project-a');
    gate.invalidate();
    expect(gate.accepts(request)).toBe(false);
  });
});
