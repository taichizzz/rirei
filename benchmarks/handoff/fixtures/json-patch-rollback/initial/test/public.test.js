import assert from 'node:assert/strict';
import test from 'node:test';
import { applyPatch } from '../src/index.js';

test('applies basic add, replace, and remove operations on flat objects', () => {
  const doc = { a: 1, b: 2 };
  const { doc: result, inversePatch } = applyPatch(doc, [
    { op: 'add', path: '/c', value: 3 },
    { op: 'replace', path: '/a', value: 10 },
    { op: 'remove', path: '/b' },
  ]);

  assert.equal(result, doc);
  assert.deepEqual(doc, { a: 10, c: 3 });
  assert.ok(Array.isArray(inversePatch));
});

test('rolls back previous operations if test operation fails', () => {
  const doc = { a: 1, b: 'original' };
  assert.throws(() => {
    applyPatch(doc, [
      { op: 'replace', path: '/a', value: 99 },
      { op: 'test', path: '/b', value: 'expected' },
    ]);
  }, /test (?:operation )?failed|mismatch|error/i);

  assert.equal(doc.a, 1);
  assert.equal(doc.b, 'original');
});

test('rejects unknown operation and restores document', () => {
  const doc = { x: 42 };
  assert.throws(() => {
    applyPatch(doc, [
      { op: 'replace', path: '/x', value: 100 },
      { op: 'unknownOp', path: '/x' },
    ]);
  }, /unsupported|unknown/i);
  assert.equal(doc.x, 42);
});
