import { Command } from 'commander';
import { createCheckpoint, taskContext } from '../lifecycle.js';

export function checkpointCommand(): Command {
  return new Command('checkpoint')
    .description(
      'Capture the current Git working-tree state without modifying it',
    )
    .option('-m, --message <message>', 'short checkpoint label')
    .action(async (options: { message?: string }) => {
      const { root, state } = await taskContext();
      const checkpoint = await createCheckpoint(root, state, options.message);
      process.stdout.write(`Created checkpoint ${checkpoint.id}\n`);
    });
}
