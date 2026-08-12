const BLOCKED = new Set(['__proto__', 'prototype', 'constructor']);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (!isPlainObject(value)) return value;
  return mergeObjects({}, value);
}

function mergeObjects(base, override) {
  const result = {};
  for (const key of Object.keys(base)) {
    if (!BLOCKED.has(key)) result[key] = clone(base[key]);
  }
  for (const key of Object.keys(override)) {
    if (BLOCKED.has(key) || override[key] === undefined) continue;
    result[key] =
      isPlainObject(override[key]) && isPlainObject(base[key])
        ? mergeObjects(base[key], override[key])
        : clone(override[key]);
  }
  return result;
}

export function mergeConfig(base, override) {
  if (isPlainObject(base) && isPlainObject(override)) {
    return mergeObjects(base, override);
  }
  return override === undefined ? clone(base) : clone(override);
}
