import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_TIMEOUT_MS, parseRetryAfter, retryDelay } from '../src/index.js';

test('supports IMF-fixdate and clamps dates', () => {
  const now = Date.parse('Sun, 06 Nov 1994 08:49:30 GMT');
  assert.equal(parseRetryAfter('Sun, 06 Nov 1994 08:49:37 GMT', now), 7_000);
  assert.equal(parseRetryAfter('Sun, 06 Nov 1994 08:49:20 GMT', now), 0);
  assert.equal(
    parseRetryAfter('Sat, 06 Nov 2094 08:49:37 GMT', now),
    MAX_TIMEOUT_MS,
  );
});

test('rejects numeric prefixes and non-IMF date forms', () => {
  for (const value of [
    '12junk',
    '+2',
    '-1',
    '1.5',
    '1e3',
    '06 Nov 1994 08:49:37 GMT',
  ]) {
    assert.equal(parseRetryAfter(value, 0), null, value);
  }
});

test('caps huge integers without overflowing and handles missing headers', () => {
  assert.equal(
    parseRetryAfter('999999999999999999999999999', 0),
    MAX_TIMEOUT_MS,
  );
  assert.equal(retryDelay({ headers: { get: () => null } }, 0), null);
  assert.equal(retryDelay({}, 0), null);
});
