import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  initializeProject,
  startTask,
} from '../../src/application/project-setup.js';
import { verifySwitchPreview } from '../../src/cli/switch.js';
import { readConfig, writeConfig } from '../../src/config/loader.js';
import { inspectCoveredSnapshot } from '../../src/context/snapshot.js';
import type { SnapshotIdentity } from '../../src/context/snapshot-schema.js';
import {
  beginVerification,
  captureVerificationEnvironment,
  classifyVerification,
  completeVerification,
  inspectVerificationState,
  sealVerificationReceipt,
  verificationCommand,
  type TrustedVerificationScope,
} from '../../src/context/verification.js';
import {
  MAX_VERIFICATION_RECEIPTS,
  type VerificationEnvironment,
  type VerificationReceipt,
} from '../../src/context/verification-schema.js';
import { handoffStateFingerprint } from '../../src/handoff.js';
import { renderHandoffDocument } from '../../src/lifecycle.js';
import { migrateState } from '../../src/state/migrations.js';
import { readState, updateState } from '../../src/state/store.js';
import { createRepository, removeRepository } from '../helpers.js';

const roots: string[] = [];
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const limits = { timeoutMs: 10000 };
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeRepository));
});
async function project() {
  const root = await realpath(await createRepository());
  roots.push(root);
  await initializeProject(root);
  const state = await startTask(root, 'Keep verification evidence honest');
  return { root, state };
}
async function fixture() {
  const context = await project();
  const snapshot = (await inspectCoveredSnapshot(context.root, limits))
    .identity;
  const environment = captureVerificationEnvironment(snapshot);
  return { ...context, snapshot, environment };
}
function receipt(
  snapshot: SnapshotIdentity,
  environment: VerificationEnvironment,
  changes: Partial<Omit<VerificationReceipt, 'hash'>> = {},
): VerificationReceipt {
  return sealVerificationReceipt({
    schemaVersion: 1,
    id: randomUUID(),
    taskId: 'fixture-task',
    source: 'relay-command',
    status: 'completed',
    command: verificationCommand('npm test'),
    workingDirectory: '/fixture',
    scope: { kind: 'configured-tests', label: null },
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:01.000Z',
    exitCode: 0,
    durationMs: 1000,
    startSnapshot: snapshot,
    endSnapshot: snapshot,
    startEnvironment: environment,
    endEnvironment: environment,
    output: 'not-captured',
    ...changes,
  });
}
function qualification(value: VerificationReceipt): TrustedVerificationScope {
  return {
    receiptId: value.id,
    snapshotId: value.endSnapshot!.id,
    environmentId: value.endEnvironment!.id,
    commandDigest: value.command.digest,
    deterministic: true,
    dependencyInputsCovered: true,
    ignoredInputsCovered: true,
    environmentInputsCovered: true,
    toolchainInputsCovered: true,
    externalState: 'none',
    clock: 'controlled',
    randomness: 'controlled',
    interval: 'sealed',
  };
}

describe('verification receipts and freshness', () => {
  it('persists pending evidence before completion and links one observed result without capturing output', async () => {
    const { root, state } = await project();
    const initialFingerprint = handoffStateFingerprint(state);
    const pending = await beginVerification(root, state.sessionId, 'npm test', {
      snapshotLimits: limits,
    });
    const started = await readState(root);
    expect(started.verificationReceipts).toEqual([pending]);
    expect(started.tests).toEqual([]);
    expect(handoffStateFingerprint(started)).not.toBe(initialFingerprint);
    expect(classifyVerification(pending).freshness).toBe('pending');
    const completed = await completeVerification(root, pending, 0, 123, {
      snapshotLimits: limits,
    });
    const saved = await readState(root);
    expect(saved.verificationReceipts).toEqual([completed]);
    expect(saved.tests).toEqual([
      expect.objectContaining({
        status: 'passed',
        exitCode: 0,
        durationMs: 123,
        verificationReceiptId: pending.id,
      }),
    ]);
    expect(completed.startSnapshot.id).toBe(completed.endSnapshot!.id);
    expect(completed.output).toBe('not-captured');
    expect(migrateState(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
    const inspection = await inspectVerificationState(
      saved,
      root,
      'npm test',
      limits,
    );
    expect(inspection.summaries).toEqual([
      expect.objectContaining({
        outcome: 'passed',
        freshness: 'current-observation',
      }),
    ]);
    expect(inspection.environment?.coverage).toBe('partial');
    await expect(
      completeVerification(root, pending, 0, 124, { snapshotLimits: limits }),
    ).rejects.toThrow('receipt changed');
    expect((await readState(root)).tests).toHaveLength(1);
  });

  it('detects edits during the test and later changes to current untracked inputs', async () => {
    const { root, state } = await project();
    const file = path.join(root, 'new-input.mjs');
    await writeFile(file, 'one');
    const pending = await beginVerification(root, state.sessionId, 'npm test', {
      snapshotLimits: limits,
    });
    await writeFile(file, 'two');
    const changed = await completeVerification(root, pending, 0, 10, {
      snapshotLimits: limits,
    });
    expect(classifyVerification(changed).reasons).toContain(
      'inputs-changed-during-verification',
    );
    const stable = await beginVerification(root, state.sessionId, 'npm test', {
      snapshotLimits: limits,
    });
    await completeVerification(root, stable, 0, 10, { snapshotLimits: limits });
    await writeFile(file, 'three');
    const inspection = await inspectVerificationState(
      await readState(root),
      root,
      'npm test',
      limits,
    );
    expect(inspection.summaries.at(-1)).toMatchObject({
      freshness: 'stale',
      reasons: ['current-input-identity-differs'],
    });
  });

  it('retains interruption as incomplete evidence and never invents a zero exit', async () => {
    const { root, state } = await project();
    const pending = await beginVerification(root, state.sessionId, 'npm test', {
      snapshotLimits: limits,
    });
    const interrupted = await completeVerification(root, pending, null, 2, {
      interrupted: true,
      snapshotLimits: limits,
    });
    expect(interrupted).toMatchObject({
      status: 'interrupted',
      exitCode: null,
    });
    const inspection = await inspectVerificationState(
      await readState(root),
      root,
      'npm test',
      limits,
    );
    expect(inspection.summaries[0]).toMatchObject({
      outcome: 'unknown',
      exitCode: null,
      freshness: 'historical',
    });
  });

  it('keeps legacy migrations and assistant success claims historical without inventing start receipts', async () => {
    const { root, state } = await project();
    const legacy = migrateState({
      ...state,
      schemaVersion: 1,
      tests: [
        {
          command: 'npm test',
          status: 'passed',
          exitCode: 0,
          durationMs: 5,
          createdAt: state.task.createdAt,
        },
      ],
    });
    expect(legacy.verificationReceipts).toBeUndefined();
    const inspection = await inspectVerificationState(legacy, root, 'npm test');
    expect(inspection.snapshot).toBeUndefined();
    expect(inspection.summaries[0]).toMatchObject({
      freshness: 'historical',
      reasons: ['qualified-receipt-unavailable'],
    });
    expect(
      classifyVerification({
        kind: 'assistant_claim',
        text: 'All tests passed.',
        exitCode: 0,
      }).freshness,
    ).toBe('historical');
  });

  it('requires complete covered boundaries and current identity even for a zero exit', async () => {
    const { snapshot, environment } = await fixture();
    const value = receipt(snapshot, environment);
    expect(classifyVerification(value, snapshot, environment).freshness).toBe(
      'current-observation',
    );
    expect(classifyVerification(value, snapshot).freshness).toBe('historical');
    expect(classifyVerification(value, undefined, environment).freshness).toBe(
      'historical',
    );
    for (const status of ['partial', 'unstable', 'unavailable'] as const) {
      const incomplete = {
        ...snapshot,
        coverage: { ...snapshot.coverage, status },
      };
      const unqualified = receipt(incomplete, environment);
      expect(
        classifyVerification(unqualified, incomplete, environment, {
          trustedScope: qualification(unqualified),
        }).freshness,
      ).toBe('historical');
    }
    for (const changes of [
      { status: 'pending' as const },
      { status: 'interrupted' as const },
      { exitCode: null },
      { endSnapshot: undefined },
      { endEnvironment: undefined },
      { endedAt: undefined },
    ]) {
      const incomplete = receipt(snapshot, environment, changes);
      expect(
        classifyVerification(incomplete, snapshot, environment).freshness,
      ).toBe(changes.status === 'pending' ? 'pending' : 'historical');
    }
  });

  it('detects configured command, workspace, dependency, runtime and allowlisted environment differences', async () => {
    const { snapshot, environment } = await fixture();
    const value = receipt(snapshot, environment);
    expect(
      classifyVerification(value, snapshot, environment, {
        expectedCommand: 'npm run integration',
      }).reasons,
    ).toEqual(['configured-command-changed']);
    expect(
      classifyVerification(value, snapshot, environment, {
        expectedCommand: null,
      }).freshness,
    ).toBe('stale');
    expect(
      classifyVerification(
        value,
        { ...snapshot, workspaceId: sha('different workspace') },
        environment,
      ).freshness,
    ).toBe('stale');
    const original = captureVerificationEnvironment(snapshot, {
      env: { NODE_ENV: 'test', TZ: 'UTC' },
    });
    const observed = receipt(snapshot, original);
    for (const next of [
      captureVerificationEnvironment(snapshot, {
        env: { NODE_ENV: 'production', TZ: 'UTC' },
      }),
      captureVerificationEnvironment(snapshot, {
        env: { NODE_ENV: 'test', TZ: 'Asia/Taipei' },
      }),
      captureVerificationEnvironment(
        { ...snapshot, dependencyDigest: sha('new lockfile') },
        { env: { NODE_ENV: 'test', TZ: 'UTC' } },
      ),
      captureVerificationEnvironment(snapshot, {
        env: { NODE_ENV: 'test', TZ: 'UTC' },
        host: { ...original.host, nodeVersion: 'v24.0.0' },
      }),
    ])
      expect(classifyVerification(observed, snapshot, next).reasons).toEqual([
        'observed-environment-differs',
      ]);
    const changed = captureVerificationEnvironment(snapshot, {
      env: { NODE_ENV: 'test', TZ: 'Asia/Taipei' },
    });
    expect(
      classifyVerification(
        receipt(snapshot, original, { endEnvironment: changed }),
        snapshot,
        changed,
      ).reasons,
    ).toEqual(['inputs-changed-during-verification']);
  });

  it('keeps arbitrary environment values and recognized secrets out of stored values and hashes', async () => {
    const { snapshot } = await fixture();
    const secret = `sk-ant-${'x'.repeat(40)}`;
    const environment = captureVerificationEnvironment(snapshot, {
      env: {
        NODE_ENV: secret,
        TZ: 'UTC',
        LANG: 'C',
        API_KEY: secret,
        AWS_SECRET_ACCESS_KEY: secret,
        CI: 'a'.repeat(161),
        LC_ALL: 'C\nsecret',
      },
    });
    expect(
      environment.values.find((value) => value.name === 'NODE_ENV'),
    ).toMatchObject({ present: true, value: null, withheld: true });
    expect(
      environment.values.find((value) => value.name === 'CI')?.withheld,
    ).toBe(true);
    expect(
      environment.values.find((value) => value.name === 'LC_ALL')?.withheld,
    ).toBe(true);
    expect(JSON.stringify(environment)).not.toContain(secret);
    expect(JSON.stringify(environment)).not.toContain(sha(secret));
    const arbitrary = captureVerificationEnvironment(snapshot, {
      env: {
        NODE_ENV: 'private-custom-value',
        TZ: 'not-a-zone',
        LANG: 'confidential-data',
        CI: 'private-custom-value',
      },
    });
    expect(
      arbitrary.values
        .filter((value) => value.present)
        .every((value) => value.value === null && value.withheld),
    ).toBe(true);
    const withheld = receipt(snapshot, environment);
    expect(
      classifyVerification(withheld, snapshot, environment, {
        trustedScope: qualification(withheld),
      }).freshness,
    ).toBe('current-observation');
    const safe = verificationCommand(`npm test --token=${secret}`);
    expect(safe.redacted).toBe(true);
    expect(safe.digest).not.toBe(sha(`npm test --token=${secret}`));
    expect(safe.text).not.toContain(secret);
    const truncated = verificationCommand('x'.repeat(4095) + '😀');
    expect(truncated.truncated).toBe(true);
    expect(truncated.text).toHaveLength(4095);
  });

  it('cannot promote ordinary network/environment-unknown tests or failed, redacted, or truncated commands', async () => {
    const { snapshot, environment } = await fixture();
    const value = receipt(snapshot, environment);
    expect(environment.unmeasured).toContain('external-service-state');
    expect(classifyVerification(value, snapshot, environment).freshness).toBe(
      'current-observation',
    );
    const trustedScope = qualification(value);
    expect(
      classifyVerification(value, snapshot, environment, { trustedScope })
        .freshness,
    ).toBe('reuse-eligible');
    for (const [key, wrong] of Object.entries({
      receiptId: randomUUID(),
      snapshotId: sha('other'),
      environmentId: sha('other'),
      commandDigest: sha('other'),
      deterministic: false,
      dependencyInputsCovered: false,
      ignoredInputsCovered: false,
      environmentInputsCovered: false,
      toolchainInputsCovered: false,
      externalState: 'network',
      clock: 'uncontrolled',
      randomness: 'uncontrolled',
      interval: 'unsealed',
    })) {
      expect(
        classifyVerification(value, snapshot, environment, {
          trustedScope: {
            ...trustedScope,
            [key]: wrong,
          } as TrustedVerificationScope,
        }).freshness,
      ).toBe('current-observation');
    }
    for (const changes of [
      { exitCode: 1 },
      {
        command: verificationCommand(
          `npm test --token=sk-ant-${'x'.repeat(40)}`,
        ),
      },
      { command: verificationCommand('x'.repeat(4097)) },
    ]) {
      const ineligible = receipt(snapshot, environment, changes);
      expect(
        classifyVerification(ineligible, snapshot, environment, {
          trustedScope: qualification(ineligible),
        }).freshness,
      ).toBe('current-observation');
    }
  });

  it('detects altered receipt bytes and suppresses a forged passed summary', async () => {
    const { root, state, snapshot, environment } = await fixture();
    const original = receipt(snapshot, environment, {
      taskId: state.sessionId,
      exitCode: 1,
    });
    const altered = { ...original, exitCode: 0 };
    expect(
      classifyVerification(altered, snapshot, environment, {
        trustedScope: qualification(original),
      }),
    ).toEqual({
      freshness: 'historical',
      reasons: ['receipt-integrity-mismatch'],
    });
    const inspection = await inspectVerificationState(
      { ...state, verificationReceipts: [altered] },
      root,
      'npm test',
      limits,
    );
    expect(inspection.summaries[0]).toMatchObject({
      freshness: 'historical',
      outcome: 'unknown',
      exitCode: null,
    });
  });

  it('limits receipt retention while preserving pending evidence and refusing a full unresolved ledger', async () => {
    const { root, state, snapshot, environment } = await fixture();
    const first = receipt(snapshot, environment, {
      taskId: state.sessionId,
      status: 'pending',
    });
    const completed = Array.from(
      { length: MAX_VERIFICATION_RECEIPTS - 1 },
      () => receipt(snapshot, environment, { taskId: state.sessionId }),
    );
    await updateState(root, (current) => ({
      ...current,
      verificationReceipts: [first, ...completed],
    }));
    const pending = await beginVerification(root, state.sessionId, 'npm test', {
      snapshotLimits: limits,
    });
    const saved = await readState(root);
    expect(saved.verificationReceipts).toHaveLength(MAX_VERIFICATION_RECEIPTS);
    expect(saved.verificationReceipts?.[0]?.id).toBe(first.id);
    expect(
      saved.verificationReceipts?.some(
        (value) => value.id === completed[0]!.id,
      ),
    ).toBe(false);
    expect(saved.verificationReceipts?.at(-1)?.id).toBe(pending.id);
    await updateState(root, (current) => ({
      ...current,
      verificationReceipts: current.verificationReceipts!.map((value) => {
        const { hash: _, ...body } = value;
        void _;
        return sealVerificationReceipt({ ...body, status: 'pending' });
      }),
    }));
    const before = await readFile(path.join(root, '.relay/state.json'), 'utf8');
    await expect(
      beginVerification(root, state.sessionId, 'npm test', {
        snapshotLimits: limits,
      }),
    ).rejects.toThrow('Unresolved verification receipt limit');
    expect(await readFile(path.join(root, '.relay/state.json'), 'utf8')).toBe(
      before,
    );
  });

  it('rejects task changes and excludes foreign-task receipts from current lookup', async () => {
    const { root, state, snapshot, environment } = await fixture();
    const foreign = receipt(snapshot, environment);
    expect(
      (
        await inspectVerificationState(
          { ...state, verificationReceipts: [foreign] },
          root,
          'npm test',
        )
      ).summaries,
    ).toEqual([]);
    await expect(
      beginVerification(root, 'old-task', 'npm test', {
        snapshotLimits: limits,
      }),
    ).rejects.toThrow('task or ownership changed');
    const pending = await beginVerification(root, state.sessionId, 'npm test', {
      snapshotLimits: limits,
    });
    await updateState(root, (current) => ({
      ...current,
      sessionId: randomUUID(),
    }));
    await expect(
      completeVerification(root, pending, 0, 1, { snapshotLimits: limits }),
    ).rejects.toThrow('task changed');
    expect((await readState(root)).tests).toEqual([]);
  });

  it('invalidates previews for receipt changes and same-name untracked edits, but not storage revisions', async () => {
    const { root, state } = await project();
    const config = await readConfig(root);
    await writeConfig(root, {
      ...config,
      tests: { ...config.tests, command: 'npm test' },
    });
    await writeFile(path.join(root, 'same-name.mjs'), 'one');
    const pending = await beginVerification(root, state.sessionId, 'npm test', {
      snapshotLimits: limits,
    });
    const pendingPreview = await renderHandoffDocument(
      root,
      await readState(root),
    );
    expect(pendingPreview.text).toContain('[pending]');
    expect(pendingPreview.text).toContain('exit unknown');
    await completeVerification(root, pending, 0, 10, {
      snapshotLimits: limits,
    });
    await expect(verifySwitchPreview(root, pendingPreview)).rejects.toThrow(
      'Handoff-relevant state or Git changed',
    );
    const approved = await renderHandoffDocument(root, await readState(root));
    expect(approved.text).toContain('[current-observation]');
    expect(approved.text).toContain('environment unqualified');
    expect(approved.coveredSnapshot?.algorithm).toBe('rirei-covered-inputs-v1');
    await updateState(root, (current) => current);
    await expect(verifySwitchPreview(root, approved)).resolves.toHaveProperty(
      'sessionId',
      state.sessionId,
    );
    await writeFile(path.join(root, 'same-name.mjs'), 'two');
    await expect(verifySwitchPreview(root, approved)).rejects.toThrow(
      'Handoff-relevant state or Git changed',
    );
    const stale = await renderHandoffDocument(root, await readState(root));
    expect(stale.text).toContain('[stale]');
    expect(stale.text).toContain('does not verify current inputs');
  });
});
