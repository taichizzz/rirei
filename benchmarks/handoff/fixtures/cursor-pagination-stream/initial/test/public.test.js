import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeCursor, decodeCursor, paginateStream } from '../src/index.js';

test('encodes and decodes cursor values', () => {
  const original = ['2026-09-01T00:00:00Z', 105];
  const encoded = encodeCursor(original);
  assert.equal(typeof encoded, 'string');
  assert.deepEqual(decodeCursor(encoded), original);
});

test('paginateStream yields items from paginated fetchPage function', async () => {
  const pages = [
    { items: [{ id: 1 }, { id: 2 }], nextCursor: 'cursor-2' },
    { items: [{ id: 3 }], nextCursor: null },
  ];
  let callCount = 0;
  async function fetchPage(cursor) {
    if (callCount === 0) {
      assert.equal(cursor, null);
    } else if (callCount === 1) {
      assert.equal(cursor, 'cursor-2');
    }
    return pages[callCount++];
  }

  const results = [];
  for await (const item of paginateStream(fetchPage)) {
    results.push(item);
  }

  assert.deepEqual(results, [{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.equal(callCount, 2);
});
