import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { relayPath } from '../../src/safety/path-policy.js';

describe('relayPath', () => {
  it('creates paths beneath the Relay directory', () => {
    expect(relayPath('/project', 'checkpoints', 'one')).toBe(
      path.join('/project', '.relay', 'checkpoints', 'one'),
    );
  });

  it('rejects path traversal', () => {
    expect(() => relayPath('/project', '..', 'state.json')).toThrow(
      'must remain within .relay',
    );
  });
});
