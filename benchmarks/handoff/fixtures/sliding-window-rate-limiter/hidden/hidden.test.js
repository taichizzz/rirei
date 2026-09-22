import assert from 'node:assert/strict';
import test from 'node:test';
import { SlidingWindowRateLimiter } from '../src/index.js';

test('atomic multi-token acquire with zero partial deduction on failure', () => {
  let currentTime = 5000;
  const limiter = new SlidingWindowRateLimiter({
    windowMs: 1000,
    maxTokens: 5,
    now: () => currentTime,
  });

  // Acquire 3 tokens (2 remain)
  const res1 = limiter.acquire(3);
  assert.equal(res1.allowed, true);
  assert.equal(res1.remaining, 2);

  // Attempt to acquire 3 tokens (exceeds available 2)
  const res2 = limiter.acquire(3);
  assert.equal(res2.allowed, false);
  assert.equal(res2.remaining, 2); // Must NOT partially deduct
  assert.equal(limiter.remaining(), 2);
  assert.ok(res2.retryAfterMs > 0);

  // Now acquire 2 tokens (allowed)
  const res3 = limiter.acquire(2);
  assert.equal(res3.allowed, true);
  assert.equal(res3.remaining, 0);
});

test('sliding window smoothly expires tokens across sub-window buckets', () => {
  let currentTime = 10000;
  const limiter = new SlidingWindowRateLimiter({
    windowMs: 1000,
    maxTokens: 10,
    subWindows: 10,
    now: () => currentTime,
  });

  // Acquire 4 tokens at t=10000
  limiter.acquire(4);

  // Advance time to t=10500 (500ms later, bucket 5)
  currentTime = 10500;
  limiter.acquire(4);
  assert.equal(limiter.remaining(), 2);

  // Advance time to t=11050 (1050ms later than first acquire)
  currentTime = 11050;
  // First 4 tokens should have expired, second 4 tokens still active
  assert.equal(limiter.remaining(), 6);

  // Advance time to t=11600 (both sets of tokens expired)
  currentTime = 11600;
  assert.equal(limiter.remaining(), 10);
});

test('computes accurate retryAfterMs based on bucket expiry', () => {
  let currentTime = 20000;
  const limiter = new SlidingWindowRateLimiter({
    windowMs: 1000,
    maxTokens: 5,
    subWindows: 10,
    now: () => currentTime,
  });

  limiter.acquire(5); // Exhaust all 5 tokens at t=20000

  currentTime = 20200; // 200ms elapsed
  const fail = limiter.acquire(1);
  assert.equal(fail.allowed, false);
  // Tokens expire at 21000, so retryAfterMs should be around 800ms
  assert.equal(fail.retryAfterMs, 800);
});

test('constructor validation rejects invalid arguments', () => {
  assert.throws(
    () => new SlidingWindowRateLimiter({ windowMs: 0, maxTokens: 10 }),
  );
  assert.throws(
    () => new SlidingWindowRateLimiter({ windowMs: 1000, maxTokens: -1 }),
  );
  assert.throws(
    () =>
      new SlidingWindowRateLimiter({
        windowMs: 1000,
        maxTokens: 10,
        subWindows: 1,
      }),
  );
});

test('reset clears all rate limiter state', () => {
  let currentTime = 30000;
  const limiter = new SlidingWindowRateLimiter({
    windowMs: 1000,
    maxTokens: 5,
    now: () => currentTime,
  });

  limiter.acquire(5);
  assert.equal(limiter.remaining(), 0);

  limiter.reset();
  assert.equal(limiter.remaining(), 5);
});

test('memory consumption is strictly bounded (never stores unbounded timestamp arrays)', () => {
  let currentTime = 40000;
  const subWindows = 5;
  const limiter = new SlidingWindowRateLimiter({
    windowMs: 1000,
    maxTokens: 10000,
    subWindows,
    now: () => currentTime,
  });

  for (let i = 0; i < 2000; i++) {
    limiter.acquire(1);
  }

  // Check that no property contains an array of 2000 timestamps
  for (const val of Object.values(limiter)) {
    if (Array.isArray(val)) {
      assert.ok(
        val.length <= subWindows,
        `Array length ${val.length} exceeds subWindows ${subWindows}`,
      );
    }
  }
});
