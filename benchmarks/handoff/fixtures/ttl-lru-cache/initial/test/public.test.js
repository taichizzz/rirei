import assert from 'node:assert/strict';
import test from 'node:test';
import { TtlLruCache } from '../src/index.js';

test('sets, gets, deletes, and clears entries', () => {
  const cache = new TtlLruCache(3, () => 100);
  cache.set('a', 1, 1_000);
  cache.set('b', 2, 1_000);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.has('b'), true);
  assert.equal(cache.delete('b'), true);
  assert.equal(cache.has('b'), false);
  cache.clear();
  assert.equal(cache.size, 0);
});

test('replaces existing values', () => {
  const cache = new TtlLruCache(2, () => 0);
  cache.set('a', 1, 100);
  cache.set('a', 2, 100);
  assert.equal(cache.get('a'), 2);
  assert.equal(cache.size, 1);
});
