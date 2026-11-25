import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  attachRecoveryBudget,
  readSessionLedger,
  reserveSession,
} from '../../benchmarks/continuity/budget.mjs';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function runs(cap = 3) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'rirei-shared-budget-'));
  roots.push(parent);
  const original = path.join(parent, 'original');
  const recovery = path.join(parent, 'recovery');
  for (const root of [original, recovery]) {
    await mkdir(root);
    await writeFile(
      path.join(root, 'protocol.json'),
      JSON.stringify({ sessionLimit: cap }),
    );
    await writeFile(path.join(root, 'sessions.json'), '[]');
  }
  return { original, recovery };
}
describe('aggregate recovery budget', () => {
  it('keeps one durable ledger, preserves the incident, and permits only new explicitly reviewed keys', async () => {
    const { original, recovery } = await runs();
    const artifacts = path.join(original, 'failed-artifacts');
    await mkdir(artifacts);
    await reserveSession(original, 'failed', 'codex', 'receiver', {
      artifactDirectory: artifacts,
    });
    await writeFile(path.join(artifacts, 'execution.json'), '{"failed":true}');
    const incident = '{"reason":"ENOSPC"}';
    await writeFile(path.join(original, 'stopped.json'), incident);
    await expect(
      reserveSession(original, 'next', 'claude', 'receiver'),
    ).rejects.toThrow('unresolved or failed');
    await attachRecoveryBudget(original, recovery, {
      allowedKeys: ['next', 'last'],
      reviewedAttemptKeys: ['failed'],
      reason:
        'Operator continued unattempted cases after local storage recovery.',
    });
    await reserveSession(recovery, 'next', 'claude', 'receiver');
    await reserveSession(recovery, 'last', 'codex', 'receiver');
    expect((await readSessionLedger(original)).entries).toHaveLength(3);
    expect((await readSessionLedger(recovery)).entries).toHaveLength(3);
    expect(
      JSON.parse(await readFile(path.join(recovery, 'sessions.json'), 'utf8')),
    ).toEqual([]);
    expect(await readFile(path.join(original, 'stopped.json'), 'utf8')).toBe(
      incident,
    );
    await expect(
      reserveSession(recovery, 'failed', 'codex', 'receiver'),
    ).rejects.toThrow('already attempted');
    await expect(
      reserveSession(recovery, 'extra', 'codex', 'receiver'),
    ).rejects.toThrow('budget is exhausted');
  });
  it('blocks an unresolved reservation and cannot reset its cap in a recovery root', async () => {
    const { original, recovery } = await runs();
    const artifacts = path.join(original, 'unresolved');
    await mkdir(artifacts);
    await reserveSession(original, 'pending', 'codex', 'receiver', {
      artifactDirectory: artifacts,
    });
    await expect(
      reserveSession(original, 'another', 'claude', 'receiver'),
    ).rejects.toThrow('unresolved');
    await expect(
      attachRecoveryBudget(original, recovery, {
        allowedKeys: ['pending'],
        reviewedAttemptKeys: ['pending'],
        reason: 'retry',
      }),
    ).rejects.toThrow('consumed');
    await writeFile(path.join(recovery, 'protocol.json'), '{"sessionLimit":4}');
    await expect(
      attachRecoveryBudget(original, recovery, {
        allowedKeys: ['new'],
        reviewedAttemptKeys: ['pending'],
        reason: 'continuation',
      }),
    ).rejects.toThrow();
  });
  it('rejects undeclared attempts even when the shared ledger has spare capacity', async () => {
    const { original, recovery } = await runs(4);
    await attachRecoveryBudget(original, recovery, {
      allowedKeys: ['only-this'],
      reviewedAttemptKeys: [],
      reason: 'Explicit continuation scope.',
    });
    await expect(
      reserveSession(recovery, 'not-reviewed', 'codex', 'receiver'),
    ).rejects.toThrow('outside');
    expect((await readSessionLedger(original)).entries).toHaveLength(0);
  });
});
