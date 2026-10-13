export function encodeCursor(values) {
  return Buffer.from(JSON.stringify(values), 'utf8').toString('base64url');
}

export function decodeCursor(cursor) {
  if (typeof cursor !== 'string') {
    throw new TypeError('Cursor must be a base64url string');
  }
  return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
}

function compareValues(a, b, order) {
  const isANull = a === null || a === undefined;
  const isBNull = b === null || b === undefined;

  if (isANull && isBNull) return 0;
  if (isANull) return 1; // NULLS LAST
  if (isBNull) return -1; // NULLS LAST

  if (a < b) return order === 'desc' ? 1 : -1;
  if (a > b) return order === 'desc' ? -1 : 1;
  return 0;
}

function compareItems(itemA, itemB, sortFields) {
  for (const field of sortFields) {
    const order = field.order || 'asc';
    const cmp = compareValues(itemA[field.field], itemB[field.field], order);
    if (cmp !== 0) return cmp;
  }
  return 0;
}

function compareWithCursorValues(item, cursorValues, sortFields) {
  for (let i = 0; i < sortFields.length; i++) {
    const field = sortFields[i];
    const order = field.order || 'asc';
    const cmp = compareValues(item[field.field], cursorValues[i], order);
    if (cmp !== 0) return cmp;
  }
  return 0;
}

export function applyKeysetFilter(items, sortFields, cursor, limit = Infinity) {
  if (!Array.isArray(items)) {
    throw new TypeError('Items must be an array');
  }
  if (!Array.isArray(sortFields) || sortFields.length === 0) {
    throw new TypeError('sortFields must be a non-empty array');
  }

  const sorted = [...items].sort((a, b) => compareItems(a, b, sortFields));

  let filtered = sorted;
  if (cursor) {
    const cursorValues = decodeCursor(cursor);
    filtered = sorted.filter(
      (item) => compareWithCursorValues(item, cursorValues, sortFields) > 0,
    );
  }

  const pageItems = filtered.slice(0, limit);
  const hasMore = filtered.length > limit;

  let nextCursor = null;
  if (hasMore && pageItems.length > 0) {
    const lastItem = pageItems[pageItems.length - 1];
    const nextValues = sortFields.map((f) => lastItem[f.field]);
    nextCursor = encodeCursor(nextValues);
  }

  return { items: pageItems, nextCursor };
}

export async function* paginateStream(fetchPage, options = {}) {
  if (typeof fetchPage !== 'function') {
    throw new TypeError('fetchPage must be a function');
  }

  const { maxItems = Infinity, initialCursor = null } = options;
  const seenCursors = new Set();
  let currentCursor = initialCursor;
  let totalYielded = 0;

  while (totalYielded < maxItems) {
    if (currentCursor !== null) {
      if (seenCursors.has(currentCursor)) {
        throw new Error(
          `Cycle detected in pagination stream: ${currentCursor}`,
        );
      }
      seenCursors.add(currentCursor);
    }

    const page = await fetchPage(currentCursor);
    if (!page || !Array.isArray(page.items) || page.items.length === 0) {
      break;
    }

    for (const item of page.items) {
      yield item;
      totalYielded++;
      if (totalYielded >= maxItems) {
        return;
      }
    }

    if (!page.nextCursor) {
      break;
    }
    currentCursor = page.nextCursor;
  }
}
