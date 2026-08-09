import { describe, expect, test, vi } from 'vitest';
import { TerminalTabsModel } from '../../desktop/renderer/terminal-tabs-model.mjs';

describe('TerminalTabsModel', () => {
  test('add, select, remove terminals', () => {
    const model = new TerminalTabsModel();
    const notify = vi.fn();
    model.subscribe(notify);

    model.addTerminal('t1', { status: 'running' }, {}, {}, {});
    expect(model.getAll().length).toBe(1);
    expect(model.getActive().id).toBe('t1');
    expect(notify).toHaveBeenCalledTimes(1);

    model.addTerminal('t2', { status: 'running' }, {}, {}, {});
    expect(model.getAll().length).toBe(2);
    // Active remains t1
    expect(model.getActive().id).toBe('t1');

    model.selectTerminal('t2');
    expect(model.getActive().id).toBe('t2');

    model.removeTerminal('t2');
    expect(model.getAll().length).toBe(1);
    expect(model.getActive().id).toBe('t1'); // Fallback to last remaining
  });

  test('update metadata and reconcile inventory', () => {
    const model = new TerminalTabsModel();
    model.addTerminal('t1', { status: 'starting', sequence: 1 }, {}, {}, {});
    model.addTerminal('t2', { status: 'running', sequence: 1 }, {}, {}, {});

    model.updateMetadata('t1', { status: 'running', sequence: 2 });
    expect(model.get('t1').metadata.status).toBe('running');

    // Reconciliation
    model.reconcileInventory([
      { id: 't1', status: 'completed', sequence: 3 }, // Update
      { id: 't3', status: 'starting', sequence: 1 }, // Not locally known, would be added via logic around reconcile, but for reconcile it just keeps what it knows
    ]);

    expect(model.get('t1').metadata.status).toBe('completed');
    expect(model.get('t2')).toBeUndefined(); // t2 was not in inventory, should be removed
  });

  test('keeps hidden terminals alive and selects a visible fallback', () => {
    const model = new TerminalTabsModel();
    model.addTerminal('t1', { status: 'running' }, {}, {}, {});
    model.addTerminal('t2', { status: 'running' }, {}, {}, {});
    model.selectTerminal('t1');

    model.setHidden('t1', true);

    expect(model.get('t1')).toBeDefined();
    expect(model.getActive()?.id).toBe('t2');
    expect(model.counts()).toMatchObject({ total: 2, hidden: 1, running: 2 });
    expect(model.selectTerminal('t1')).toBe(false);
  });

  test('rejects duplicate and out-of-order sequences', () => {
    const model = new TerminalTabsModel();
    model.addTerminal('t1', { status: 'running', sequence: 4 }, {}, {}, {});
    expect(model.updateSequence('t1', 4)).toBe(false);
    expect(model.updateSequence('t1', 3)).toBe(false);
    expect(model.updateSequence('t1', 5)).toBe(true);
  });

  test('accepts output that arrives after a newer status event', () => {
    const model = new TerminalTabsModel();
    model.addTerminal(
      't1',
      { status: 'running', sequence: 4, outputSequence: 2 },
      {},
      {},
      {},
    );
    model.updateMetadata('t1', { status: 'stopping', sequence: 6 });
    expect(model.updateOutputSequence('t1', 5)).toBe(true);
    expect(model.get('t1').sequence).toBe(6);
  });
});
