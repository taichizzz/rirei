import { describe, expect, it } from 'vitest';
import {
  buildControllerIdentity,
  controllerIdFor,
} from '../../src/application/controller.js';

describe('controller identity', () => {
  it('builds a uuid-backed, boot-qualified cli identity', () => {
    const identity = buildControllerIdentity({ kind: 'cli' });
    expect(identity.kind).toBe('cli');
    expect(identity.pid).toBe(process.pid);
    expect(identity.bootId).toBeTruthy();
    expect(identity.instanceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(controllerIdFor(identity)).toBe(
      `cli:${identity.bootId}:${identity.instanceId}`,
    );
  });

  it('uses the terminal id as the stable identity for terminal-owned runs', () => {
    const identity = buildControllerIdentity({ terminalId: 'terminal-1' });
    expect(identity).toMatchObject({
      kind: 'desktop',
      instanceId: 'terminal-1',
      pid: expect.any(Number),
    });
    expect(controllerIdFor(identity)).toBe(
      `desktop:${identity.bootId}:terminal-1`,
    );
  });

  it('collision-proofs cli ids across processes and hosts', () => {
    const first = buildControllerIdentity({ kind: 'cli' });
    const second = buildControllerIdentity({ kind: 'cli' });
    expect(first.instanceId).not.toBe(second.instanceId);
  });

  it('reuses a supplied identity unchanged', () => {
    const supplied = buildControllerIdentity({ kind: 'desktop' });
    const reused = buildControllerIdentity({ identity: supplied });
    expect(reused).toEqual(supplied);
    expect(controllerIdFor(reused)).toBe(
      `desktop:${supplied.bootId}:${supplied.instanceId}`,
    );
  });
});
