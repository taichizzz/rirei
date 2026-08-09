import { Command } from 'commander';
import { recoverOrphanedRun } from '../application/sessions.js';
import { discoverRepository } from '../git/repository.js';
import { recoverStaleRun } from '../state/recovery.js';
import { readState } from '../state/store.js';

export function recoverCommand(): Command {
  return new Command('recover')
    .description('Clear stale run state after a provider process has stopped')
    .option(
      '--force',
      'confirm that no Relay-controlled provider process is running',
    )
    .option('--run-id <id>', 'recover a specific orphaned run')
    .option('--reason <text>', 'record why forced recovery is safe')
    .action(
      async (options: { force?: boolean; runId?: string; reason?: string }) => {
        if (!options.force)
          throw new Error(
            'Relay cannot verify that the provider process has exited. Rerun with --force only after confirming no Relay-controlled provider process is running.',
          );
        const projectRoot = await discoverRepository(process.cwd());
        if (!projectRoot)
          throw new Error('Relay must be run inside a Git repository.');
        const state = await readState(projectRoot);
        const orphaned = state.runs.filter((run) => run.status === 'orphaned');
        const target = options.runId
          ? orphaned.find((run) => run.runId === options.runId)
          : orphaned.length === 1
            ? orphaned[0]
            : undefined;
        if (!options.runId && orphaned.length > 1)
          throw new Error(
            'Several orphaned runs exist. Choose one with --run-id <id>.',
          );
        if (options.runId && !target)
          throw new Error(`No orphaned run ${options.runId} exists.`);
        if (!target && state.runs.length > 0)
          throw new Error(
            'The recorded provider still has an active controller. Stop it through that controller; forced recovery is only allowed for orphaned runs.',
          );
        const recovered = target
          ? await recoverOrphanedRun({
              projectRoot,
              runId: target.runId,
              requestedBy: `cli:${process.pid}`,
              reason:
                options.reason?.trim() || 'user confirmed provider stopped',
            })
          : await recoverStaleRun(projectRoot, state);
        process.stdout.write(
          recovered
            ? 'Recovered the stale Relay run as interrupted.\n'
            : 'No stale Relay run is recorded.\n',
        );
      },
    );
}
