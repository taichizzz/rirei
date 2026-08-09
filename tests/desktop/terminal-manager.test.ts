import { describe, expect, test } from 'vitest';
import { TerminalManager } from '../../desktop/terminal-manager.mjs';

describe('TerminalManager', () => {
  test('creates up to four running terminals and rejects fifth', () => {
    const manager = new TerminalManager();
    const owner = 1;
    const project = '/test/project';

    manager.reserveTerminal(owner, 'w1', 'rirei/w1', project, 'claude');
    manager.reserveTerminal(owner, 'w2', 'rirei/w2', project, 'codex');
    manager.reserveTerminal(owner, 'w3', 'rirei/w3', project, 'claude');
    manager.reserveTerminal(owner, 'w4', 'rirei/w4', project, 'codex');

    expect(manager.runningCount()).toBe(4);

    expect(() => {
      manager.reserveTerminal(owner, 'w5', 'rirei/w5', project, 'claude');
    }).toThrow(/Maximum of 4 active terminals reached/);
  });

  test('allows another terminal after one completes', () => {
    const manager = new TerminalManager();
    const owner = 1;
    const project = '/test/project';

    const t1 = manager.reserveTerminal(
      owner,
      'w1',
      'rirei/w1',
      project,
      'claude',
    );
    manager.reserveTerminal(owner, 'w2', 'rirei/w2', project, 'claude');
    manager.reserveTerminal(owner, 'w3', 'rirei/w3', project, 'claude');
    manager.reserveTerminal(owner, 'w4', 'rirei/w4', project, 'claude');

    manager.finalize(t1.id, 0, null, null);

    expect(manager.runningCount()).toBe(3);

    manager.reserveTerminal(owner, 'w5', 'rirei/w5', project, 'claude');
    expect(manager.runningCount()).toBe(4);
  });

  test('authorizes actions only for the owning webContents', () => {
    const manager = new TerminalManager();
    const owner = 1;
    const otherOwner = 2;
    const t1 = manager.reserveTerminal(
      owner,
      'w1',
      'rirei/w1',
      '/project',
      'claude',
    );

    expect(manager.get(t1.id, owner)).not.toBeNull();
    expect(manager.get(t1.id, otherOwner)).toBeNull();
  });

  test('allows only one active terminal per working tree', () => {
    const manager = new TerminalManager();
    manager.reserveTerminal(1, 'shared', 'rirei/shared', '/project', 'claude');
    expect(() =>
      manager.reserveTerminal(2, 'shared', 'rirei/shared', '/project', 'codex'),
    ).toThrow(/already claimed/);
  });

  test('routes output and keeps independent bounded buffers', () => {
    const manager = new TerminalManager();
    const t1 = manager.reserveTerminal(
      1,
      'w1',
      'rirei/w1',
      '/project',
      'claude',
    );
    const t2 = manager.reserveTerminal(
      1,
      'w2',
      'rirei/w2',
      '/project',
      'claude',
    );

    manager.appendOutput(t1.id, Buffer.from('hello t1'));
    manager.appendOutput(t2.id, Buffer.from('hello t2'));

    expect(manager.get(t1.id, 1).buffer).toBe('hello t1');
    expect(manager.get(t2.id, 1).buffer).toBe('hello t2');
  });

  test('finalizes only once across error and close', () => {
    const manager = new TerminalManager();
    const t1 = manager.reserveTerminal(
      1,
      'w1',
      'rirei/w1',
      '/project',
      'claude',
    );

    expect(manager.finalize(t1.id, 0, null, null)).toBe(true);
    expect(manager.finalize(t1.id, null, null, new Error('error'))).toBe(false);

    expect(manager.get(t1.id, 1).status).toBe('completed');
  });

  test('classifies an interrupted stopping terminal as cancelled', () => {
    const manager = new TerminalManager();
    const terminal = manager.reserveTerminal(
      1,
      'w1',
      'rirei/w1',
      '/project',
      'claude',
    );
    manager.setStatus(terminal.id, 'stopping');
    manager.finalize(terminal.id, 130, null, null);
    expect(manager.get(terminal.id, 1).status).toBe('cancelled');
  });

  test('returns complete inventory', () => {
    const manager = new TerminalManager();
    const t1 = manager.reserveTerminal(
      1,
      'w1',
      'rirei/w1',
      '/project',
      'claude',
    );
    manager.finalize(t1.id, 0, null, null);
    const t2 = manager.reserveTerminal(
      1,
      'w2',
      'rirei/w2',
      '/project',
      'codex',
    );

    const inv = manager.inventory(1);
    expect(inv.length).toBe(2);
    expect(inv.find((t) => t.id === t1.id).status).toBe('completed');
    expect(inv.find((t) => t.id === t2.id).status).toBe('starting');
  });

  test('retains completed terminals until close', () => {
    const manager = new TerminalManager();
    const t1 = manager.reserveTerminal(
      1,
      'w1',
      'rirei/w1',
      '/project',
      'claude',
    );
    manager.finalize(t1.id, 0, null, null);

    expect(manager.get(t1.id, 1)).not.toBeNull();

    expect(manager.remove(t1.id, 1)).toBe(true);
    expect(manager.get(t1.id, 1)).toBeNull();
  });

  test('destroying an owner handles every owned running terminal', () => {
    const manager = new TerminalManager();
    manager.reserveTerminal(1, 'w1', 'rirei/w1', '/project', 'claude');
    manager.reserveTerminal(1, 'w2', 'rirei/w2', '/project', 'claude');
    manager.reserveTerminal(2, 'w3', 'rirei/w3', '/project', 'claude');

    const ownedBy1 = manager.getAllForOwner(1);
    expect(ownedBy1.length).toBe(2);
    const ownedBy2 = manager.getAllForOwner(2);
    expect(ownedBy2.length).toBe(1);
  });

  test('rolls back an unspawned reservation', () => {
    const manager = new TerminalManager();
    const terminal = manager.reserveTerminal(
      1,
      'default',
      'main',
      '/project',
      'claude',
    );
    expect(manager.cancelReservation(terminal.id)).toBe(true);
    expect(manager.runningCount()).toBe(0);
  });

  test('delivers one bounded output batch at a time', () => {
    const manager = new TerminalManager(4, 1_000_000, 32);
    const terminal = manager.reserveTerminal(
      1,
      'w1',
      'rirei/canonical',
      '/project',
      'claude',
    );
    manager.appendOutput(terminal.id, Buffer.from('first'));
    const first = manager.takePendingOutput(terminal.id);
    manager.appendOutput(terminal.id, Buffer.from('second'));

    expect(first?.data).toBe('first');
    expect(manager.takePendingOutput(terminal.id)).toBeNull();
    expect(manager.acknowledgeOutput(terminal.id, first!.sequence, 1)).toBe(
      true,
    );
    expect(manager.takePendingOutput(terminal.id)?.data).toBe('second');
    expect(manager.inventory(1)[0]!.branchLabel).toBe('rirei/canonical');
  });

  test('does not resend pending output already included in inventory', () => {
    const manager = new TerminalManager();
    const terminal = manager.reserveTerminal(
      1,
      'w1',
      'rirei/w1',
      '/project',
      'claude',
    );
    manager.appendOutput(terminal.id, Buffer.from('before snapshot'));
    const snapshot = manager.inventory(1)[0]!;
    manager.appendOutput(terminal.id, Buffer.from('after snapshot'));

    manager.acknowledgeOutput(terminal.id, snapshot.sequence, 1);

    expect(manager.takePendingOutput(terminal.id)?.data).toBe('after snapshot');
  });

  test('decodes stdout and stderr independently', () => {
    const manager = new TerminalManager();
    const terminal = manager.reserveTerminal(
      1,
      'w1',
      'rirei/w1',
      '/project',
      'claude',
    );
    const bytes = Buffer.from('😀');
    manager.appendOutput(terminal.id, bytes.subarray(0, 2), 'stdout');
    manager.appendOutput(terminal.id, Buffer.from('error'), 'stderr');
    manager.appendOutput(terminal.id, bytes.subarray(2), 'stdout');
    expect(manager.get(terminal.id, 1).buffer).toBe('error😀');
  });
});
