import { Command } from 'commander';
import { readCheckpointDiff } from '../checkpoints.js';
import { discoverRepository } from '../git/repository.js';

export function checkpointDiffCommand(): Command {
  return new Command('checkpoint-diff')
    .description('Display the saved patch from a retained Relay checkpoint')
    .argument('<id>', 'checkpoint ID')
    .option('--json', 'print machine-readable JSON')
    .action(async (id: string, options: { json?: boolean }) => {
      const root = await discoverRepository(process.cwd());
      if (!root) throw new Error('Relay must be run inside a Git repository.');
      const result = await readCheckpointDiff(root, id);
      if (options.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }
      for (const warning of result.warnings)
        process.stderr.write(`Warning: ${warning}\n`);
      if (!result.patch) {
        process.stdout.write('(No saved text patch.)\n');
        return;
      }
      process.stdout.write(result.patch);
      if (!result.patch.endsWith('\n')) process.stdout.write('\n');
    });
}
