import assert from 'node:assert/strict';
import test from 'node:test';
import { TtlLruCache } from '../src/index.js';

test('expires lazily with ttl zero expiring immediately', () => {
  let now = 10;
  const cache = new TtlLruCache(2, () => now);
  cache.set('a', 1, 5);
  cache.set('zero', 0, 0);
  assert.equal(cache.has('zero'), false);
  now = 15;
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.size, 0);
});

test('get refreshes LRU while has does not', () => {
  const cache = new TtlLruCache(2, () => 0);
  cache.set('a', 1, 100);
  cache.set('b', 2, 100);
  assert.equal(cache.has('a'), true);
  cache.set('c', 3, 100);
  assert.equal(cache.has('a'), false);
  assert.equal(cache.get('b'), 2);
  cache.set('d', 4, 100);
  assert.equal(cache.has('c'), false);
  assert.equal(cache.has('b'), true);
});

test('expired entries do not consume capacity', () => {
  let now = 0;
  const cache = new TtlLruCache(2, () => now);
  cache.set('a', 1, 1);
  cache.set('b', 2, 10);
  now = 2;
  cache.set('c', 3, 10);
  assert.equal(cache.has('b'), true);
  assert.equal(cache.has('c'), true);
  assert.equal(cache.size, 2);
});

test('validates capacity and ttl', () => {
  for (const capacity of [0, -1, 1.5, Infinity]) {
    assert.throws(() => new TtlLruCache(capacity));
  }
  const cache = new TtlLruCache(1);
  for (const ttl of [-1, Infinity, NaN]) {
    assert.throws(() => cache.set('a', 1, ttl));
  }
});
