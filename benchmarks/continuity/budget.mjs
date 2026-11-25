import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { withDirectoryLock } from '../../src/state/lock.ts';

const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
const hash = (value) => createHash('sha256').update(value).digest('hex');
async function atomic(directory, name, value) {
  const temporary = path.join(directory, `.budget-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(value, null, 2) + '\n');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path.join(directory, name));
    if (process.platform !== 'win32') {
      const parent = await open(directory, 'r');
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}
async function context(runRoot) {
  const current = await realpath(runRoot);
  const bytes = await readFile(path.join(current, 'protocol.json')).catch(
    (error) => {
      if (error.code === 'ENOENT') return Buffer.from('{"sessionLimit":12}');
      throw error;
    },
  );
  const local = JSON.parse(bytes);
  const root = local.budgetLedgerRoot
    ? await realpath(local.budgetLedgerRoot)
    : current;
  let originalBytes = bytes;
  if (root !== current)
    originalBytes = await readFile(path.join(root, 'protocol.json'));
  const original = JSON.parse(originalBytes);
  assert.ok(
    Number.isSafeInteger(original.sessionLimit) &&
      original.sessionLimit > 0 &&
      original.sessionLimit <= 12,
    'Invalid session cap.',
  );
  assert.equal(
    local.sessionLimit,
    original.sessionLimit,
    'Recovery cannot reset the session cap.',
  );
  if (root !== current)
    assert.equal(
      local.budgetFamilyHash,
      hash(originalBytes),
      'Shared budget protocol changed.',
    );
  return {
    current,
    root,
    limit: original.sessionLimit,
    familyHash: hash(originalBytes),
    local,
  };
}
export async function readSessionLedger(runRoot) {
  const state = await context(runRoot);
  const entries = await json(path.join(state.root, 'sessions.json'));
  assert.ok(
    Array.isArray(entries) &&
      entries.length <= state.limit &&
      new Set(entries.map((entry) => entry.key)).size === entries.length,
    'Corrupt session ledger.',
  );
  return { ...state, entries };
}
export async function reserveSession(
  runRoot,
  key,
  provider,
  role,
  { artifactDirectory } = {},
) {
  const state = await context(runRoot);
  return withDirectoryLock(state.root, 'budget', async () => {
    const { entries, limit } = await readSessionLedger(runRoot);
    if (entries.some((entry) => entry.key === key))
      throw new Error(
        'Session already attempted; automatic reruns are forbidden.',
      );
    if (entries.length >= limit)
      throw new Error(`The ${limit}-session budget is exhausted.`);
    let decision = null;
    if (state.current !== state.root) {
      assert.match(state.local.recoveryDecisionId ?? '', /^[a-f0-9-]{36}$/);
      decision = await json(
        path.join(
          state.root,
          `recovery-${state.local.recoveryDecisionId}.json`,
        ),
      );
      assert.equal(decision.budgetFamilyHash, state.familyHash);
      assert.equal(decision.recoveryRoot, state.current);
      assert.ok(
        decision.allowedKeys.includes(key),
        'Attempt is outside the explicit recovery decision.',
      );
    }
    for (const previous of entries.filter((entry) => entry.artifactDirectory)) {
      const finished = await json(
        path.resolve(state.root, previous.artifactDirectory, 'execution.json'),
      ).catch(() => null);
      if (
        (!finished || finished.failed) &&
        !decision?.reviewedAttemptKeys.includes(previous.key)
      )
        throw new Error(
          'A prior attempt is unresolved or failed; review recovery before launching another provider.',
        );
    }
    const entry = {
      number: entries.length + 1,
      key,
      provider,
      role,
      startedAt: new Date().toISOString(),
      ...(artifactDirectory
        ? { artifactDirectory: path.relative(state.root, artifactDirectory) }
        : {}),
    };
    await atomic(state.root, 'sessions.json', [...entries, entry]);
    process.stdout.write(
      `Session ${entry.number}/${limit}: ${key} (${provider})\n`,
    );
    return entry;
  });
}

/** Explicit continuation of unattempted keys; the original ledger/stop record and cap remain authoritative. */
export async function attachRecoveryBudget(
  originalRoot,
  recoveryRoot,
  { allowedKeys, reviewedAttemptKeys, reason },
) {
  assert.ok(
    Array.isArray(allowedKeys) &&
      allowedKeys.length &&
      new Set(allowedKeys).size === allowedKeys.length,
  );
  assert.ok(
    Array.isArray(reviewedAttemptKeys) &&
      typeof reason === 'string' &&
      reason.trim() &&
      reason.length <= 2000,
  );
  const original = await context(originalRoot);
  const recovery = await context(recoveryRoot);
  assert.notEqual(original.root, recovery.current);
  assert.equal(
    recovery.current,
    recovery.root,
    'A recovery root cannot already belong to another family.',
  );
  assert.equal(recovery.limit, original.limit);
  assert.equal((await readSessionLedger(recoveryRoot)).entries.length, 0);
  return withDirectoryLock(original.root, 'budget', async () => {
    const { entries } = await readSessionLedger(originalRoot);
    assert.ok(
      allowedKeys.every(
        (key) =>
          typeof key === 'string' &&
          key &&
          !entries.some((entry) => entry.key === key),
      ),
      'Recovery cannot retry a consumed key.',
    );
    assert.ok(
      reviewedAttemptKeys.every((key) =>
        entries.some((entry) => entry.key === key),
      ),
    );
    assert.ok(
      allowedKeys.length <= original.limit - entries.length,
      'Recovery exceeds the remaining cap.',
    );
    const id = randomUUID();
    const stopped = await readFile(
      path.join(original.current, 'stopped.json'),
    ).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    const decision = {
      schemaVersion: 1,
      id,
      budgetFamilyHash: original.familyHash,
      recoveryRoot: recovery.current,
      allowedKeys,
      reviewedAttemptKeys,
      reason,
      carriedLaunches: entries.length,
      sessionLimit: original.limit,
      priorStopHash: stopped ? hash(stopped) : null,
      recordedAt: new Date().toISOString(),
    };
    await atomic(original.root, `recovery-${id}.json`, decision);
    await atomic(recovery.current, 'protocol.json', {
      ...recovery.local,
      budgetLedgerRoot: original.root,
      budgetFamilyHash: original.familyHash,
      recoveryDecisionId: id,
    });
    return decision;
  });
}
