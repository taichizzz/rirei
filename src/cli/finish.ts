import { spawn } from 'node:child_process';
import { Command } from 'commander';
import { readConfig } from '../config/loader.js';
import { createCheckpoint, taskContext } from '../lifecycle.js';
import { appendEvent } from '../state/events.js';
import { writeState } from '../state/store.js';

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
      let state = context.state;
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
        state = {
          ...state,
          tests: [
            ...state.tests,
            {
              command: config.tests.command,
              status: exitCode === 0 ? 'passed' : 'failed',
              exitCode,
              durationMs: Date.now() - started,
              createdAt: now,
            },
          ],
          task: { ...state.task, updatedAt: now },
        };
        await writeState(context.root, state);
        if (exitCode !== 0)
          throw new Error(
            `Configured tests failed with exit code ${exitCode ?? 'unknown'}.`,
          );
      }
      const checkpoint = await createCheckpoint(context.root, state, 'Final');
      const now = new Date().toISOString();
      const completed = {
        ...checkpoint.state,
        currentAgent: undefined,
        task: {
          ...checkpoint.state.task,
          status: 'completed' as const,
          updatedAt: now,
        },
      };
      await writeState(context.root, completed);
      await appendEvent(context.root, 'task_completed', {
        checkpointId: checkpoint.id,
      });
      process.stdout.write(
        `Completed Relay task with checkpoint ${checkpoint.id}\n`,
      );
    });
}
