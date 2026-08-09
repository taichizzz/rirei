import { Command } from 'commander';
import { discoverRepository } from '../git/repository.js';
import { searchTaskHistory } from '../state/history.js';

export function historyCommand(): Command {
  return new Command('history')
    .description('Search current and archived Relay task metadata')
    .argument('[query]', 'case-insensitive metadata filter')
    .option('--json', 'print machine-readable JSON')
    .action(async (query: string | undefined, options: { json?: boolean }) => {
      const projectRoot = await discoverRepository(process.cwd());
      if (!projectRoot)
        throw new Error('Relay must be run inside a Git repository.');
      const history = await searchTaskHistory(projectRoot, query);
      if (options.json) {
        process.stdout.write(`${JSON.stringify(history, null, 2)}\n`);
        return;
      }
      if (history.length === 0) {
        process.stdout.write('No matching Relay task history.\n');
        return;
      }
      process.stdout.write(
        `${history
          .map((entry) => {
            const providers = [
              ...new Set(entry.runs.map((run) => run.provider)),
            ];
            return `${entry.updatedAt.slice(0, 10)}  ${entry.status.padEnd(9)}  ${entry.title}  [${providers.join(', ') || 'no providers'}]`;
          })
          .join('\n')}\n`,
      );
    });
}
