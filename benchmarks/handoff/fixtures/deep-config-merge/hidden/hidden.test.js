import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeConfig } from '../src/index.js';

test('blocks prototype-sensitive keys recursively', () => {
  const attack = JSON.parse(
    '{"safe":{"__proto__":{"polluted":true},"constructor":{"x":1},"prototype":{"y":2},"ok":3}}',
  );
  const result = mergeConfig({}, attack);
  assert.deepEqual(result, { safe: { ok: 3 } });
  assert.equal({}.polluted, undefined);
});

test('returns a deep independent copy including arrays', () => {
  const base = { nested: { values: [{ x: 1 }] } };
  const result = mergeConfig(base, {});
  result.nested.values[0].x = 9;
  result.nested.values.push({ x: 2 });
  assert.deepEqual(base, { nested: { values: [{ x: 1 }] } });
});

test('handles null-prototype objects and replacing null', () => {
  const base = Object.assign(Object.create(null), { a: { x: 1 }, b: 2 });
  const override = Object.assign(Object.create(null), { a: { y: 3 }, b: null });
  assert.deepEqual(mergeConfig(base, override), { a: { x: 1, y: 3 }, b: null });
});

test('does not recurse into class instances', () => {
  class Box {
    constructor(value) {
      this.value = value;
    }
  }
  const box = new Box(2);
  assert.equal(mergeConfig({ item: { old: true } }, { item: box }).item, box);
});
