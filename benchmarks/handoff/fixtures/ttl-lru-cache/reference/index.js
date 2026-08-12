export class TtlLruCache {
  #entries = new Map();
  #maxEntries;
  #now;

  constructor(maxEntries, now = Date.now) {
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new TypeError('maxEntries must be a positive integer');
    }
    if (typeof now !== 'function')
      throw new TypeError('now must be a function');
    this.#maxEntries = maxEntries;
    this.#now = now;
  }

  #purgeExpired(now) {
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(key);
    }
  }

  set(key, value, ttlMs) {
    if (!Number.isFinite(ttlMs) || ttlMs < 0) {
      throw new TypeError('ttlMs must be finite and nonnegative');
    }
    const now = this.#now();
    this.#purgeExpired(now);
    this.#entries.delete(key);
    if (ttlMs === 0) return this;
    this.#entries.set(key, { value, expiresAt: now + ttlMs });
    while (this.#entries.size > this.#maxEntries) {
      this.#entries.delete(this.#entries.keys().next().value);
    }
    return this;
  }

  get(key) {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.#now()) {
      this.#entries.delete(key);
      return undefined;
    }
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  has(key) {
    const entry = this.#entries.get(key);
    if (!entry) return false;
    if (entry.expiresAt <= this.#now()) {
      this.#entries.delete(key);
      return false;
    }
    return true;
  }

  delete(key) {
    return this.#entries.delete(key);
  }

  clear() {
    this.#entries.clear();
  }

  get size() {
    this.#purgeExpired(this.#now());
    return this.#entries.size;
  }
}
