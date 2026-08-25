import { Command } from 'commander';
import { reconcileProjectRuns } from '../application/reconciliation.js';
import { discoverRepository } from '../git/repository.js';

export function reconcileCommand(): Command {
  return new Command('reconcile')
    .description('Check durable run ownership without releasing worktrees')
    .option('--json', 'print machine-readable reconciliation results')
    .option('--daemon-id <id>', 'complete daemon inventory owner')
    .option('--daemon-pid <pid>', 'complete daemon inventory process')
    .option('--daemon-boot-id <id>', 'complete daemon inventory boot')
    .option('--terminal-id <ids...>', 'terminal IDs in the complete inventory')
    .action(
      async (options: {
        json?: boolean;
        daemonId?: string;
        daemonPid?: string;
        daemonBootId?: string;
        terminalId?: string[];
      }) => {
        const projectRoot = await discoverRepository(process.cwd());
        if (!projectRoot)
          throw new Error('Relay must be run inside a Git repository.');
        const daemonFields = [
          options.daemonId,
          options.daemonPid,
          options.daemonBootId,
        ];
        if (daemonFields.some(Boolean) && !daemonFields.every(Boolean))
          throw new Error('Daemon inventory identity is incomplete.');
        if (options.terminalId && !options.daemonId)
          throw new Error('Terminal inventory requires a daemon identity.');
        const daemonPid = options.daemonPid
          ? Number.parseInt(options.daemonPid, 10)
          : undefined;
        if (
          daemonPid !== undefined &&
          (!Number.isInteger(daemonPid) || daemonPid <= 0)
        )
          throw new Error('Invalid daemon inventory process.');
        const result = await reconcileProjectRuns(
          projectRoot,
          options.daemonId
            ? {
                instanceId: options.daemonId,
                pid: daemonPid!,
                bootId: options.daemonBootId!,
                terminalIds: new Set(options.terminalId ?? []),
              }
            : undefined,
        );
        if (options.json) {
          process.stdout.write(`${JSON.stringify(result.runs, null, 2)}\n`);
          return;
        }
        if (result.runs.length === 0) {
          process.stdout.write('No active run leases are recorded.\n');
          return;
        }
        process.stdout.write(
          `${result.runs.map((run) => `${run.runId}: ${run.status} (${run.reason})`).join('\n')}\n`,
        );
      },
    );
}
