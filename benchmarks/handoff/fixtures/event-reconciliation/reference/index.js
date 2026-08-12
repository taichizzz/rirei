function compare(left, right) {
  return (
    left.sequence - right.sequence ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  );
}

export function reconcileEvents(events) {
  if (!Array.isArray(events)) throw new TypeError('events must be an array');
  const byId = new Map();
  for (const event of events) {
    if (!event || typeof event !== 'object')
      throw new TypeError('event must be an object');
    if (typeof event.id !== 'string' || event.id.length === 0)
      throw new TypeError('event id must be nonempty');
    if (!Number.isInteger(event.sequence) || event.sequence < 0)
      throw new TypeError('sequence must be a nonnegative integer');
    if (byId.has(event.id)) throw new Error(`duplicate event id: ${event.id}`);
    if (event.after !== undefined && !Array.isArray(event.after))
      throw new TypeError('after must be an array');
    byId.set(event.id, event);
  }
  const indegree = new Map();
  const dependents = new Map(events.map((event) => [event.id, []]));
  for (const event of events) {
    const dependencies = event.after ?? [];
    const unique = new Set();
    for (const dependency of dependencies) {
      if (typeof dependency !== 'string' || !byId.has(dependency))
        throw new Error(`unknown dependency: ${dependency}`);
      if (dependency === event.id)
        throw new Error(`self-dependency: ${event.id}`);
      if (unique.has(dependency))
        throw new Error(`duplicate dependency: ${dependency}`);
      unique.add(dependency);
      dependents.get(dependency).push(event.id);
    }
    indegree.set(event.id, unique.size);
  }
  const ready = events
    .filter((event) => indegree.get(event.id) === 0)
    .sort(compare);
  const result = [];
  while (ready.length > 0) {
    const event = ready.shift();
    result.push(event);
    for (const id of dependents.get(event.id)) {
      indegree.set(id, indegree.get(id) - 1);
      if (indegree.get(id) === 0) {
        ready.push(byId.get(id));
        ready.sort(compare);
      }
    }
  }
  if (result.length !== events.length)
    throw new Error('dependency cycle detected');
  return result;
}
