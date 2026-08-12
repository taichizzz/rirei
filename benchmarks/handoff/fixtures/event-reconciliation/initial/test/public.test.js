import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileEvents } from '../src/index.js';

test('orders independent events by sequence then id', () => {
  const events = [
    { id: 'z', sequence: 2, payload: 1 },
    { id: 'b', sequence: 1, payload: 2 },
    { id: 'a', sequence: 1, payload: 3 },
  ];
  assert.deepEqual(
    reconcileEvents(events).map((event) => event.id),
    ['a', 'b', 'z'],
  );
});

test('validates basic event shape and duplicate ids', () => {
  assert.throws(() => reconcileEvents(null));
  assert.throws(() => reconcileEvents([{ id: '', sequence: 0 }]));
  assert.throws(() => reconcileEvents([{ id: 'a', sequence: -1 }]));
  assert.throws(() =>
    reconcileEvents([
      { id: 'a', sequence: 0 },
      { id: 'a', sequence: 1 },
    ]),
  );
});
