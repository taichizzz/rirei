function parsePointer(pointer) {
  if (
    typeof pointer !== 'string' ||
    (!pointer.startsWith('/') && pointer !== '')
  ) {
    throw new Error(`Invalid JSON pointer: ${pointer}`);
  }
  if (pointer === '') return [];
  return pointer
    .slice(1)
    .split('/')
    .map((token) => token.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function tokensToPath(tokens) {
  if (tokens.length === 0) return '';
  return (
    '/' +
    tokens
      .map((token) => token.replace(/~/g, '~0').replace(/\//g, '~1'))
      .join('/')
  );
}

function resolveParent(doc, tokens) {
  let current = doc;
  for (let i = 0; i < tokens.length - 1; i++) {
    const token = tokens[i];
    if (current == null || typeof current !== 'object') {
      throw new Error(`Cannot resolve path component: ${token}`);
    }
    current = current[token];
  }
  if (current == null || typeof current !== 'object') {
    throw new Error('Target parent is not an object or array');
  }
  return current;
}

function deepEquals(a, b) {
  if (Object.is(a, b)) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEquals(a[i], b[i])) return false;
    }
    return true;
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (
      !Object.prototype.hasOwnProperty.call(b, k) ||
      !deepEquals(a[k], b[k])
    ) {
      return false;
    }
  }
  return true;
}

function getValue(doc, path) {
  const tokens = parsePointer(path);
  if (tokens.length === 0) return doc;
  const parent = resolveParent(doc, tokens);
  const key = tokens[tokens.length - 1];
  if (Array.isArray(parent)) {
    if (!/^\d+$/.test(key)) throw new Error(`Invalid array index: ${key}`);
    const index = Number(key);
    if (index < 0 || index >= parent.length) {
      throw new Error(`Array index out of bounds: ${index}`);
    }
    return parent[index];
  }
  if (!Object.prototype.hasOwnProperty.call(parent, key)) {
    throw new Error(`Property does not exist: ${key}`);
  }
  return parent[key];
}

function executeSingleOp(doc, op) {
  if (!op || typeof op !== 'object') throw new Error('Invalid operation');
  const { op: action, path } = op;

  if (action === 'add') {
    const tokens = parsePointer(path);
    if (tokens.length === 0) throw new Error('Cannot add to document root');
    const parent = resolveParent(doc, tokens);
    const key = tokens[tokens.length - 1];
    if (Array.isArray(parent)) {
      let index;
      if (key === '-') {
        index = parent.length;
      } else {
        if (!/^\d+$/.test(key)) throw new Error(`Invalid array index: ${key}`);
        index = Number(key);
        if (index < 0 || index > parent.length) {
          throw new Error(`Array index out of bounds: ${index}`);
        }
      }
      parent.splice(index, 0, op.value);
      const indexPath = tokensToPath([...tokens.slice(0, -1), String(index)]);
      return [{ op: 'remove', path: indexPath }];
    }
    if (Object.prototype.hasOwnProperty.call(parent, key)) {
      const prev = parent[key];
      parent[key] = op.value;
      return [{ op: 'replace', path, value: prev }];
    }
    parent[key] = op.value;
    return [{ op: 'remove', path }];
  }

  if (action === 'remove') {
    const tokens = parsePointer(path);
    if (tokens.length === 0) throw new Error('Cannot remove document root');
    const parent = resolveParent(doc, tokens);
    const key = tokens[tokens.length - 1];
    if (Array.isArray(parent)) {
      if (!/^\d+$/.test(key)) throw new Error(`Invalid array index: ${key}`);
      const index = Number(key);
      if (index < 0 || index >= parent.length) {
        throw new Error(`Array index out of bounds: ${index}`);
      }
      const prev = parent[index];
      parent.splice(index, 1);
      return [{ op: 'add', path, value: prev }];
    }
    if (!Object.prototype.hasOwnProperty.call(parent, key)) {
      throw new Error(`Property does not exist: ${key}`);
    }
    const prev = parent[key];
    delete parent[key];
    return [{ op: 'add', path, value: prev }];
  }

  if (action === 'replace') {
    const tokens = parsePointer(path);
    if (tokens.length === 0) throw new Error('Cannot replace document root');
    const parent = resolveParent(doc, tokens);
    const key = tokens[tokens.length - 1];
    if (Array.isArray(parent)) {
      if (!/^\d+$/.test(key)) throw new Error(`Invalid array index: ${key}`);
      const index = Number(key);
      if (index < 0 || index >= parent.length) {
        throw new Error(`Array index out of bounds: ${index}`);
      }
      const prev = parent[index];
      parent[index] = op.value;
      return [{ op: 'replace', path, value: prev }];
    }
    if (!Object.prototype.hasOwnProperty.call(parent, key)) {
      throw new Error(`Property does not exist: ${key}`);
    }
    const prev = parent[key];
    parent[key] = op.value;
    return [{ op: 'replace', path, value: prev }];
  }

  if (action === 'test') {
    const actual = getValue(doc, path);
    if (!deepEquals(actual, op.value)) {
      throw new Error(`Test operation failed for path: ${path}`);
    }
    return [];
  }

  if (action === 'move') {
    if (op.from === op.path) return [];
    const value = getValue(doc, op.from);
    const removeInverses = executeSingleOp(doc, {
      op: 'remove',
      path: op.from,
    });
    try {
      const addInverses = executeSingleOp(doc, {
        op: 'add',
        path: op.path,
        value,
      });
      return [...addInverses, ...removeInverses];
    } catch (err) {
      for (const inv of removeInverses) {
        executeSingleOp(doc, inv);
      }
      throw err;
    }
  }

  if (action === 'copy') {
    const value = getValue(doc, op.from);
    return executeSingleOp(doc, { op: 'add', path: op.path, value });
  }

  throw new Error(`Unsupported patch operation: ${action}`);
}

export function applyPatch(doc, patch) {
  if (doc == null || typeof doc !== 'object') {
    throw new TypeError('Target document must be an object or array');
  }
  if (!Array.isArray(patch)) {
    throw new TypeError('Patch must be an array of operations');
  }

  const inverseStack = [];
  try {
    for (const op of patch) {
      const inverses = executeSingleOp(doc, op);
      for (const inv of inverses) {
        inverseStack.push(inv);
      }
    }
  } catch (error) {
    while (inverseStack.length > 0) {
      const inv = inverseStack.pop();
      try {
        executeSingleOp(doc, inv);
      } catch {
        // Continue rolling back best effort
      }
    }
    throw error;
  }

  return { doc, inversePatch: inverseStack.reverse() };
}
