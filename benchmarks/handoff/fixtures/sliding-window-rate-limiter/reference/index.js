export class SlidingWindowRateLimiter {
  constructor(options = {}) {
    const { windowMs, maxTokens, subWindows = 10, now = Date.now } = options;
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new TypeError('windowMs must be a positive number');
    }
    if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
      throw new TypeError('maxTokens must be a positive number');
    }
    if (!Number.isInteger(subWindows) || subWindows < 2) {
      throw new TypeError('subWindows must be an integer >= 2');
    }
    if (typeof now !== 'function') {
      throw new TypeError('now must be a function');
    }

    this.windowMs = windowMs;
    this.maxTokens = maxTokens;
    this.subWindows = subWindows;
    this.subWindowMs = windowMs / subWindows;
    this.now = now;

    this.ring = new Array(subWindows)
      .fill(null)
      .map(() => ({ startTime: 0, tokens: 0 }));
  }

  _sync(currentTime) {
    for (let i = 0; i < this.subWindows; i++) {
      const bucket = this.ring[i];
      if (
        bucket.startTime > 0 &&
        currentTime - bucket.startTime >= this.windowMs
      ) {
        bucket.startTime = 0;
        bucket.tokens = 0;
      }
    }
  }

  _currentBucket(currentTime) {
    this._sync(currentTime);
    const bucketIndex =
      Math.floor(currentTime / this.subWindowMs) % this.subWindows;
    const bucketStartTime =
      Math.floor(currentTime / this.subWindowMs) * this.subWindowMs;
    const bucket = this.ring[bucketIndex];
    if (bucket.startTime !== bucketStartTime) {
      bucket.startTime = bucketStartTime;
      bucket.tokens = 0;
    }
    return bucket;
  }

  _usedTokens(currentTime) {
    this._sync(currentTime);
    let total = 0;
    for (let i = 0; i < this.subWindows; i++) {
      const bucket = this.ring[i];
      if (
        bucket.startTime > 0 &&
        currentTime - bucket.startTime < this.windowMs
      ) {
        total += bucket.tokens;
      }
    }
    return total;
  }

  remaining() {
    const currentTime = this.now();
    const used = this._usedTokens(currentTime);
    return Math.max(0, this.maxTokens - used);
  }

  acquire(tokens = 1) {
    if (!Number.isFinite(tokens) || tokens <= 0) {
      throw new TypeError('tokens must be a positive number');
    }
    const currentTime = this.now();
    const used = this._usedTokens(currentTime);
    const available = Math.max(0, this.maxTokens - used);

    if (tokens > available) {
      const neededFreed = used + tokens - this.maxTokens;
      let freed = 0;
      let retryAfterMs = this.windowMs;

      const activeBuckets = this.ring
        .filter(
          (b) =>
            b.startTime > 0 &&
            b.tokens > 0 &&
            currentTime - b.startTime < this.windowMs,
        )
        .sort((a, b) => a.startTime - b.startTime);

      for (const bucket of activeBuckets) {
        freed += bucket.tokens;
        if (freed >= neededFreed) {
          const expiresAt = bucket.startTime + this.windowMs;
          retryAfterMs = Math.max(1, expiresAt - currentTime);
          break;
        }
      }

      return {
        allowed: false,
        remaining: available,
        retryAfterMs,
      };
    }

    const bucket = this._currentBucket(currentTime);
    bucket.tokens += tokens;

    return {
      allowed: true,
      remaining: available - tokens,
      retryAfterMs: 0,
    };
  }

  reset() {
    for (let i = 0; i < this.subWindows; i++) {
      this.ring[i].startTime = 0;
      this.ring[i].tokens = 0;
    }
  }
}
