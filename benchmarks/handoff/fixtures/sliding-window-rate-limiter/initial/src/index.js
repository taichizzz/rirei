export class SlidingWindowRateLimiter {
  constructor(options = {}) {
    void options;
    throw new Error('TODO: implement SlidingWindowRateLimiter');
  }

  acquire(tokens = 1) {
    void tokens;
    throw new Error('TODO: implement acquire');
  }

  remaining() {
    throw new Error('TODO: implement remaining');
  }

  reset() {
    throw new Error('TODO: implement reset');
  }
}
