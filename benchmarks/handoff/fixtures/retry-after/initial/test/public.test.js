import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRetryAfter, retryDelay } from '../src/index.js';

test('parses integer delay-seconds as milliseconds', () => {
  assert.equal(parseRetryAfter('0', 1_000), 0);
  assert.equal(parseRetryAfter(' 12 ', 1_000), 12_000);
});

test('reads Retry-After from a response-like object', () => {
  const response = {
    headers: { get: (name) => (name === 'retry-after' ? '3' : null) },
  };
  assert.equal(retryDelay(response, 0), 3_000);
});

test('returns null for basic malformed values', () => {
  for (const value of [null, undefined, '', 'later', 4]) {
    assert.equal(parseRetryAfter(value, 0), null);
  }
});
