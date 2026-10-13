import assert from 'node:assert/strict';
import test from 'node:test';
import {
  encodeCursor,
  decodeCursor,
  applyKeysetFilter,
  paginateStream,
} from '../src/index.js';

test('encodeCursor generates URL-safe base64url without padding characters', () => {
  const values = ['special?name=&val', 9999];
  const cursor = encodeCursor(values);
  assert.equal(cursor.includes('='), false);
  assert.equal(cursor.includes('+'), false);
  assert.equal(cursor.includes('/'), false);
  assert.deepEqual(decodeCursor(cursor), values);
});

test('applyKeysetFilter enforces NULLS LAST in both asc and desc sort orders', () => {
  const items = [
    { id: 1, priority: 10 },
    { id: 2, priority: null },
    { id: 3, priority: 5 },
    { id: 4, priority: undefined },
    { id: 5, priority: 20 },
  ];

  // DESC order: 20, 10, 5, null, undefined
  const descResult = applyKeysetFilter(
    items,
    [
      { field: 'priority', order: 'desc' },
      { field: 'id', order: 'asc' },
    ],
    null,
    10,
  );
  assert.deepEqual(
    descResult.items.map((i) => i.id),
    [5, 1, 3, 2, 4],
  );

  // ASC order: 5, 10, 20, null, undefined
  const ascResult = applyKeysetFilter(
    items,
    [
      { field: 'priority', order: 'asc' },
      { field: 'id', order: 'asc' },
    ],
    null,
    10,
  );
  assert.deepEqual(
    ascResult.items.map((i) => i.id),
    [3, 1, 5, 2, 4],
  );
});

test('applyKeysetFilter keyset continuation across multiple pages', () => {
  const items = [
    { score: 100, id: 'a' },
    { score: 90, id: 'b' },
    { score: 90, id: 'c' },
    { score: 80, id: 'd' },
  ];
  const sortFields = [
    { field: 'score', order: 'desc' },
    { field: 'id', order: 'asc' },
  ];

  const page1 = applyKeysetFilter(items, sortFields, null, 2);
  assert.deepEqual(
    page1.items.map((i) => i.id),
    ['a', 'b'],
  );
  assert.ok(page1.nextCursor);

  const page2 = applyKeysetFilter(items, sortFields, page1.nextCursor, 2);
  assert.deepEqual(
    page2.items.map((i) => i.id),
    ['c', 'd'],
  );
  assert.equal(page2.nextCursor, null);
});

test('paginateStream aborts and throws on cursor cycles', async () => {
  const cycles = [
    { items: [{ id: 1 }], nextCursor: 'loop-cursor' },
    { items: [{ id: 2 }], nextCursor: 'loop-cursor' },
  ];
  let call = 0;
  async function fetchLooping(cursor) {
    void cursor;
    return cycles[call++];
  }

  await assert.rejects(async () => {
    for await (const _ of paginateStream(fetchLooping)) {
      // iterate
    }
  }, /cycle/i);
});

test('paginateStream respects maxItems cap across pages', async () => {
  const pages = [
    { items: [1, 2, 3], nextCursor: 'c1' },
    { items: [4, 5, 6], nextCursor: 'c2' },
    { items: [7, 8, 9], nextCursor: null },
  ];
  let call = 0;
  async function fetcher(cursor) {
    void cursor;
    return pages[call++];
  }

  const yielded = [];
  for await (const item of paginateStream(fetcher, { maxItems: 5 })) {
    yielded.push(item);
  }

  assert.deepEqual(yielded, [1, 2, 3, 4, 5]);
  assert.equal(call, 2);
});
