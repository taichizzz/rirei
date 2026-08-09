import { Command } from 'commander';
import { listCheckpoints } from '../checkpoints.js';
import { discoverRepository } from '../git/repository.js';

export function checkpointsCommand(): Command {
  return new Command('checkpoints')
    .description('List retained checkpoints for the current Relay task')
    .option('--json', 'print machine-readable JSON')
    .action(async (options: { json?: boolean }) => {
      const root = await discoverRepository(process.cwd());
      if (!root) throw new Error('Relay must be run inside a Git repository.');
      const checkpoints = await listCheckpoints(root);
      if (options.json) {
        process.stdout.write(
          `${JSON.stringify({ count: checkpoints.length, checkpoints }, null, 2)}\n`,
        );
        return;
      }
      if (checkpoints.length === 0) {
        process.stdout.write('No retained checkpoints for the current task.\n');
        return;
      }
      process.stdout.write(
        `${checkpoints
          .map(
            (checkpoint) =>
              `${checkpoint.createdAt}  ${checkpoint.id}${checkpoint.label ? `  ${checkpoint.label}` : ''}`,
          )
          .join('\n')}\n`,
      );
    });
}
