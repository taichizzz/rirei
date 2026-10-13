import assert from 'node:assert/strict';
import test from 'node:test';
import { SlidingWindowRateLimiter } from '../src/index.js';

test('acquires single tokens within capacity', () => {
  let currentTime = 1000;
  const limiter = new SlidingWindowRateLimiter({
    windowMs: 1000,
    maxTokens: 5,
    now: () => currentTime,
  });

  const res1 = limiter.acquire();
  assert.equal(res1.allowed, true);
  assert.equal(res1.remaining, 4);
  assert.equal(res1.retryAfterMs, 0);

  assert.equal(limiter.remaining(), 4);
});

test('rejects acquire when tokens are exhausted', () => {
  let currentTime = 1000;
  const limiter = new SlidingWindowRateLimiter({
    windowMs: 1000,
    maxTokens: 2,
    now: () => currentTime,
  });

  limiter.acquire();
  limiter.acquire();
  const res = limiter.acquire();
  assert.equal(res.allowed, false);
  assert.equal(res.remaining, 0);
  assert.ok(res.retryAfterMs > 0);
});
