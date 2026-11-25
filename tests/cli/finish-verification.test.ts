import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  initializeProject,
  startTask,
} from '../../src/application/project-setup.js';
import { finishCommand } from '../../src/cli/finish.js';
import { readConfig, writeConfig } from '../../src/config/loader.js';
import { inspectVerificationState } from '../../src/context/verification.js';
import { readState } from '../../src/state/store.js';
import { createRepository, removeRepository } from '../helpers.js';

const fixtures = vi.hoisted(() => ({ spawn: vi.fn(), taskContext: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: fixtures.spawn,
}));
vi.mock('../../src/lifecycle.js', async (original) => ({
  ...(await original<typeof import('../../src/lifecycle.js')>()),
  taskContext: fixtures.taskContext,
}));
const roots: string[] = [];
afterEach(async () => {
  vi.resetAllMocks();
  await Promise.all(roots.splice(0).map(removeRepository));
});

describe('finish verification process failures', () => {
  it.each(['spawn-error', 'synchronous-error', 'signal-exit'] as const)(
    'retains an interrupted receipt and does not finish after %s',
    async (failure) => {
      const root = await realpath(await createRepository());
      roots.push(root);
      await initializeProject(root);
      const state = await startTask(root, 'Handle incomplete verification');
      const config = await readConfig(root);
      await writeConfig(root, {
        ...config,
        tests: { ...config.tests, command: 'fixture-test-command' },
      });
      fixtures.taskContext.mockResolvedValue({ root, state });
      fixtures.spawn.mockImplementation(() => {
        const persisted = JSON.parse(
          readFileSync(path.join(root, '.relay/state.json'), 'utf8'),
        );
        expect(persisted.verificationReceipts.at(-1).status).toBe('pending');
        if (failure === 'synchronous-error')
          throw new Error('fixture synchronous spawn failure');
        const child = new EventEmitter();
        queueMicrotask(() => {
          if (failure === 'spawn-error')
            child.emit(
              'error',
              Object.assign(new Error('fixture asynchronous spawn failure'), {
                code: 'EAGAIN',
              }),
            );
          else child.emit('exit', null, 'SIGTERM');
        });
        return child;
      });
      await expect(
        finishCommand().parseAsync(['--run-tests'], { from: 'user' }),
      ).rejects.toThrow(
        failure === 'signal-exit' ? 'exit code unknown' : 'spawn failure',
      );
      expect(fixtures.spawn).toHaveBeenCalledOnce();
      const saved = await readState(root);
      expect(saved.task.status).toBe('active');
      expect(saved.checkpoints).toEqual([]);
      expect(saved.verificationReceipts).toHaveLength(1);
      expect(saved.verificationReceipts![0]).toMatchObject({
        status: 'interrupted',
        exitCode: null,
        output: 'not-captured',
      });
      const inspection = await inspectVerificationState(
        saved,
        root,
        config.tests.command,
      );
      expect(inspection.summaries[0]).toMatchObject({
        outcome: 'unknown',
        exitCode: null,
        freshness: 'historical',
      });
    },
  );
});
