import { spawn } from 'node:child_process';
import { Command } from 'commander';
import { readConfig } from '../config/loader.js';
import { createCheckpoint, taskContext } from '../lifecycle.js';
import { appendEvent } from '../state/events.js';
import { activeLeases } from '../state/leases.js';
import { updateState } from '../state/store.js';

async function runConfiguredTest(
  root: string,
  command: string,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd: root, shell: true, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', resolve);
  });
}

export function finishCommand(): Command {
  return new Command('finish')
    .description('Create a final checkpoint and mark the task completed')
    .option('--run-tests', 'run the configured test command before completing')
    .action(async (options: { runTests?: boolean }) => {
      const context = await taskContext();
      if (activeLeases(context.state).length > 0)
        throw new Error(
          'Cannot finish while a provider run still owns a working tree. Stop it or recover the orphaned run first.',
        );
      if (options.runTests) {
        const config = await readConfig(context.root);
        if (!config.tests.command)
          throw new Error(
            'No tests.command is configured in .relay/config.json.',
          );
        const started = Date.now();
        const exitCode = await runConfiguredTest(
          context.root,
          config.tests.command,
        );
        const now = new Date().toISOString();
        const command = config.tests.command;
        await updateState(context.root, (current) => ({
          ...current,
          tests: [
            ...current.tests,
            {
              command,
              status: exitCode === 0 ? 'passed' : 'failed',
              exitCode,
              durationMs: Date.now() - started,
              createdAt: now,
            },
          ],
          task: { ...current.task, updatedAt: now },
        }));
        if (exitCode !== 0)
          throw new Error(
            `Configured tests failed with exit code ${exitCode ?? 'unknown'}.`,
          );
        await appendEvent(context.root, 'test_run', {
          command,
          status: exitCode === 0 ? 'passed' : 'failed',
          durationMs: Date.now() - started,
        });
      }
      const checkpoint = await createCheckpoint(context.root, 'Final');
      const now = new Date().toISOString();
      await updateState(context.root, (current) => {
        if (activeLeases(current).length > 0)
          throw new Error(
            'Cannot finish because a provider run started while the final checkpoint was being created.',
          );
        return {
          ...current,
          task: {
            ...current.task,
            status: 'completed' as const,
            updatedAt: now,
          },
        };
      });
      await appendEvent(context.root, 'task_completed', {
        checkpointId: checkpoint.id,
      });
      process.stdout.write(
        `Completed Relay task with checkpoint ${checkpoint.id}\n`,
      );
    });
}
