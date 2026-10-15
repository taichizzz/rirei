import { Command } from 'commander';
import { startTask } from '../application/project-setup.js';

export function startCommand(): Command {
  return new Command('start')
    .description('Start a durable Relay task')
    .argument('<task>', 'original task request')
    .option('--allow-dirty', 'allow a task to begin with uncommitted changes')
    .action(async (task: string, options: { allowDirty?: boolean }) => {
      const state = await startTask(process.cwd(), task, options);
      process.stdout.write(`Started Relay task ${state.sessionId}\n`);
      if (state.git.dirtyAtStart)
        process.stdout.write(
          'Warning: the working tree was already dirty at task start.\n',
        );
    });
}
