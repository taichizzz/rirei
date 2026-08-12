import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileEvents } from '../src/index.js';

test('honors dependencies ahead of lower sequence values', () => {
  const events = [
    { id: 'deploy', sequence: 0, after: ['build'] },
    { id: 'notify', sequence: 1, after: ['deploy'] },
    { id: 'build', sequence: 9 },
    { id: 'audit', sequence: 1 },
  ];
  assert.deepEqual(
    reconcileEvents(events).map((event) => event.id),
    ['audit', 'build', 'deploy', 'notify'],
  );
});

test('rejects unknown, self, duplicate dependencies and cycles', () => {
  assert.throws(
    () => reconcileEvents([{ id: 'a', sequence: 0, after: ['missing'] }]),
    /unknown/i,
  );
  assert.throws(
    () => reconcileEvents([{ id: 'a', sequence: 0, after: ['a'] }]),
    /self/i,
  );
  assert.throws(
    () =>
      reconcileEvents([
        { id: 'a', sequence: 0 },
        { id: 'b', sequence: 1, after: ['a', 'a'] },
      ]),
    /duplicate/i,
  );
  assert.throws(
    () =>
      reconcileEvents([
        { id: 'a', sequence: 0, after: ['b'] },
        { id: 'b', sequence: 1, after: ['a'] },
      ]),
    /cycle/i,
  );
});

test('is deterministic and does not mutate input arrays', () => {
  const after = ['a'];
  const events = [
    { id: 'c', sequence: 2, after },
    { id: 'b', sequence: 1 },
    { id: 'a', sequence: 1 },
  ];
  const before = JSON.stringify(events);
  assert.deepEqual(
    reconcileEvents(events).map((event) => event.id),
    ['a', 'b', 'c'],
  );
  assert.equal(JSON.stringify(events), before);
  assert.deepEqual(after, ['a']);
});
