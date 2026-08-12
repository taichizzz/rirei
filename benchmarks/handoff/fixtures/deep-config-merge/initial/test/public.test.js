import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeConfig } from '../src/index.js';

test('recursively merges plain objects', () => {
  const base = { server: { host: 'localhost', port: 80 }, enabled: true };
  const override = { server: { port: 443 } };
  assert.deepEqual(mergeConfig(base, override), {
    server: { host: 'localhost', port: 443 },
    enabled: true,
  });
});

test('arrays replace and undefined retains', () => {
  assert.deepEqual(
    mergeConfig(
      { tags: ['a'], retries: 2 },
      { tags: ['b'], retries: undefined },
    ),
    { tags: ['b'], retries: 2 },
  );
});

test('does not mutate top-level inputs', () => {
  const base = { nested: { a: 1 } };
  const override = { nested: { b: 2 } };
  mergeConfig(base, override);
  assert.deepEqual(base, { nested: { a: 1 } });
  assert.deepEqual(override, { nested: { b: 2 } });
});
