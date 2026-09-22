import assert from 'node:assert/strict';
import test from 'node:test';
import { applyPatch } from '../src/index.js';

test('RFC 6901 pointer unescaping with ~0 and ~1', () => {
  const doc = {
    'a/b': 1,
    'm~n': 2,
    nested: { 'k/v': 'val' },
  };

  applyPatch(doc, [
    { op: 'replace', path: '/a~1b', value: 10 },
    { op: 'replace', path: '/m~0n', value: 20 },
    { op: 'add', path: '/nested/k~1v2', value: 'val2' },
  ]);

  assert.equal(doc['a/b'], 10);
  assert.equal(doc['m~n'], 20);
  assert.equal(doc.nested['k/v2'], 'val2');
});

test('supports array operations: index insertion, removal, and append -', () => {
  const doc = { items: ['a', 'b'] };

  applyPatch(doc, [
    { op: 'add', path: '/items/-', value: 'c' },
    { op: 'add', path: '/items/1', value: 'inserted' },
  ]);
  assert.deepEqual(doc.items, ['a', 'inserted', 'b', 'c']);

  applyPatch(doc, [
    { op: 'remove', path: '/items/1' },
    { op: 'replace', path: '/items/2', value: 'z' },
  ]);
  assert.deepEqual(doc.items, ['a', 'b', 'z']);
});

test('move and copy operations', () => {
  const doc = { orig: { text: 'hello' } };

  applyPatch(doc, [
    { op: 'copy', from: '/orig/text', path: '/copied' },
    { op: 'move', from: '/orig/text', path: '/moved' },
  ]);

  assert.equal(doc.copied, 'hello');
  assert.equal(doc.moved, 'hello');
  assert.equal(doc.orig.text, undefined);
});

test('atomic rollback preserves non-JSON values (Date, RegExp, undefined, BigInt, Symbol)', () => {
  const created = new Date(1700000000000);
  const pattern = /test-pattern/i;
  const sym = Symbol('token');
  const big = 999999999999999999999999n;

  const doc = {
    created,
    pattern,
    sym,
    big,
    optional: undefined,
    items: [1, 2, 3],
  };

  assert.throws(() => {
    applyPatch(doc, [
      { op: 'add', path: '/items/-', value: 4 },
      { op: 'replace', path: '/created', value: 'corrupted' },
      { op: 'replace', path: '/optional', value: 'set' },
      { op: 'test', path: '/items/0', value: 999 }, // Will fail!
    ]);
  });

  assert.deepEqual(doc.items, [1, 2, 3]);
  assert.equal(doc.created, created);
  assert.equal(doc.pattern, pattern);
  assert.equal(doc.sym, sym);
  assert.equal(doc.big, big);
  assert.equal(doc.optional, undefined);
  assert.ok('optional' in doc);
});

test('rolls back multi-step complex mutations when deep path is missing', () => {
  const doc = { list: [10, 20], nested: { count: 5 } };

  assert.throws(() => {
    applyPatch(doc, [
      { op: 'add', path: '/list/1', value: 15 },
      { op: 'replace', path: '/nested/count', value: 6 },
      { op: 'replace', path: '/nonexistent/deep/key', value: 'boom' },
    ]);
  });

  assert.deepEqual(doc.list, [10, 20]);
  assert.equal(doc.nested.count, 5);
  assert.equal(doc.nonexistent, undefined);
});
