import { execFile } from 'node:child_process';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  initializeProject,
  startTask,
} from '../../src/application/project-setup.js';
import { readConfig, writeConfig } from '../../src/config/loader.js';
import {
  beginVerification,
  completeVerification,
} from '../../src/context/verification.js';
import { setContextConsent } from '../../src/context/store.js';
import { issueMessageCapability } from '../../src/messages/capability.js';
import { readState, updateState } from '../../src/state/store.js';
import { createRepository, removeRepository } from '../helpers.js';

const execute = promisify(execFile);
const roots: string[] = [];
const entry = fileURLToPath(new URL('../../src/index.ts', import.meta.url));
const compiled = fileURLToPath(
  new URL('../../dist/index.cjs', import.meta.url),
);
const loader = new URL(
  '../../node_modules/tsx/dist/loader.mjs',
  import.meta.url,
).href;
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeRepository));
});

async function project(mode: 'source' | 'compiled' = 'source') {
  const root = await realpath(await createRepository());
  roots.push(root);
  await initializeProject(root);
  const state = await startTask(root, 'Record host-observed tests');
  const env = { ...process.env };
  const relay = (...args: string[]) =>
    execute(
      process.execPath,
      mode === 'source'
        ? ['--import', loader, entry, ...args]
        : [compiled, ...args],
      { cwd: root, env },
    );
  const configure = async (program: string) => {
    await writeFile(path.join(root, '.relay/test-command.cjs'), program);
    const command = `"${process.execPath}" ".relay/test-command.cjs"`;
    const config = await readConfig(root);
    await writeConfig(root, { ...config, tests: { ...config.tests, command } });
    return command;
  };
  return { root, state, env, relay, configure };
}

describe('verification CLI', () => {
  it.each(['source', 'compiled'] as const)(
    'records a durable pending receipt before tests and exposes a read-only qualified lookup (%s)',
    async (mode) => {
      const context = await project(mode);
      const command = await context.configure(`
      const fs = require('node:fs');
      const assert = require('node:assert/strict');
      const state = JSON.parse(fs.readFileSync('.relay/state.json', 'utf8'));
      assert.equal(state.verificationReceipts.at(-1).status, 'pending');
      console.log('TEST_OUTPUT_NOT_RETAINED_IN_RECEIPT');
    `);
      const result = await context.relay('finish', '--run-tests');
      expect(result.stdout).toContain('Completed Relay task');
      const saved = await readState(context.root);
      const value = saved.verificationReceipts![0]!;
      expect(saved.task.status).toBe('completed');
      expect(saved.tests[0]).toMatchObject({
        command,
        exitCode: 0,
        status: 'passed',
        verificationReceiptId: value.id,
      });
      expect(value).toMatchObject({
        source: 'relay-command',
        status: 'completed',
        exitCode: 0,
        output: 'not-captured',
      });
      expect(value.endSnapshot!.id).toBe(value.startSnapshot.id);
      const before = await readFile(
        path.join(context.root, '.relay/state.json'),
        'utf8',
      );
      const lookup = JSON.parse(
        (await context.relay('context', 'verification', '--receipt', value.id))
          .stdout,
      );
      expect(lookup).toMatchObject({
        source: 'relay_host_test_receipts',
        workspace: context.root,
        automaticTestReuse: false,
        receipt: value,
      });
      expect(lookup.summaries).toEqual([
        expect.objectContaining({
          receiptId: value.id,
          freshness: 'current-observation',
          outcome: 'passed',
        }),
      ]);
      expect(lookup.environment.coverage).toBe('partial');
      expect(JSON.stringify(value)).not.toContain(
        'TEST_OUTPUT_NOT_RETAINED_IN_RECEIPT',
      );
      expect(
        await readFile(path.join(context.root, '.relay/state.json'), 'utf8'),
      ).toBe(before);
      await expect(
        context.relay('context', 'verification', '--receipt', 'missing'),
      ).rejects.toThrow('not found in the current task');
    },
  );

  it('keeps failed tests active and executes each explicitly requested run', async () => {
    const context = await project();
    await context.configure(`
      const fs = require('node:fs');
      const count = fs.existsSync('.relay/test-count') ? Number(fs.readFileSync('.relay/test-count')) : 0;
      fs.writeFileSync('.relay/test-count', String(count + 1));
      process.exitCode = 7;
    `);
    for (let attempt = 0; attempt < 2; attempt++)
      await expect(context.relay('finish', '--run-tests')).rejects.toThrow(
        'Configured tests failed with exit code 7',
      );
    const state = await readState(context.root);
    expect(state.task.status).toBe('active');
    expect(state.checkpoints).toEqual([]);
    expect(state.verificationReceipts).toHaveLength(2);
    expect(state.tests).toHaveLength(2);
    expect(
      state.tests.every(
        (value) => value.status === 'failed' && value.exitCode === 7,
      ),
    ).toBe(true);
    expect(
      await readFile(path.join(context.root, '.relay/test-count'), 'utf8'),
    ).toBe('2');
    const lookup = JSON.parse(
      (await context.relay('context', 'verification')).stdout,
    );
    expect(
      lookup.summaries.every(
        (value: { freshness: string; outcome: string }) =>
          value.freshness === 'current-observation' &&
          value.outcome === 'failed',
      ),
    ).toBe(true);
    expect(lookup.automaticTestReuse).toBe(false);
  });

  it('marks an observed zero exit stale when the command changes covered files during verification', async () => {
    const context = await project();
    await context.configure(
      `require('node:fs').writeFileSync('README.md', 'changed during verification');`,
    );
    await context.relay('finish', '--run-tests');
    const lookup = JSON.parse(
      (await context.relay('context', 'verification')).stdout,
    );
    expect(lookup.summaries[0]).toMatchObject({
      exitCode: 0,
      freshness: 'stale',
      reasons: ['inputs-changed-during-verification'],
    });
  });

  it('uses current configured command identity without running a lookup command', async () => {
    const context = await project();
    const command = await context.configure(
      `throw new Error('A lookup must never run this command');`,
    );
    const pending = await beginVerification(
      context.root,
      context.state.sessionId,
      command,
    );
    await completeVerification(context.root, pending, 0, 10);
    const config = await readConfig(context.root);
    await writeConfig(context.root, {
      ...config,
      tests: { ...config.tests, command: `${command} --changed` },
    });
    const lookup = JSON.parse(
      (await context.relay('context', 'verification')).stdout,
    );
    expect(lookup.summaries[0]).toMatchObject({
      freshness: 'stale',
      reasons: ['configured-command-changed'],
    });
    expect((await readState(context.root)).tests).toHaveLength(1);
  });

  it('applies managed-run consent and current worktree authority to receipt inspection', async () => {
    const context = await project();
    const command = await context.configure('');
    const pending = await beginVerification(
      context.root,
      context.state.sessionId,
      command,
    );
    await completeVerification(context.root, pending, 0, 1);
    const other = path.join(context.root, '.relay/other-worktree');
    await execute('git', ['worktree', 'add', '--detach', other, 'HEAD'], {
      cwd: context.root,
    });
    const now = new Date().toISOString();
    const runId = 'verification-reader';
    await updateState(context.root, (current) => ({
      ...current,
      runs: [
        {
          runId,
          displayLabel: 'Codex verification reader',
          agent: 'codex',
          worktreePath: other,
          projectRoot: context.root,
          launchMode: 'new',
          controllerId: 'cli:fixture',
          controller: { kind: 'cli', instanceId: 'fixture', bootId: 'fixture' },
          startedAt: now,
          lastSeenAt: now,
          status: 'running',
          lifecycleStatus: 'working',
          activeRuntimeSeconds: 0,
          runtimeSequence: 0,
        },
      ],
    }));
    const capability = await issueMessageCapability(
      context.root,
      context.state.sessionId,
      runId,
    );
    Object.assign(context.env, capability.env);
    await expect(context.relay('context', 'verification')).rejects.toThrow(
      'Context disclosure is disabled',
    );
    await setContextConsent(context.root, context.state.sessionId, true);
    const lookup = JSON.parse(
      (await context.relay('context', 'verification', '--receipt', pending.id))
        .stdout,
    );
    expect(lookup.workspace).toBe(await realpath(other));
    expect(lookup.receipt.workingDirectory).toBe(context.root);
    expect(lookup.summaries[0]).toMatchObject({
      freshness: 'stale',
      reasons: ['current-input-identity-differs'],
    });
    expect(lookup.historicalPathNotice).toContain('another worktree');
  });
});
