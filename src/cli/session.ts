import { Command } from 'commander';
import { taskContext } from '../lifecycle.js';
import { resolveCurrentActor } from '../messages/capability.js';
import {
  renameSessionLabel,
  validateSessionLabel,
} from '../state/run-labels.js';

export function sessionCommand(): Command {
  const session = new Command('session').description(
    'Manage durable session metadata and aliases.',
  );

  session
    .command('label <runRef> <label>')
    .description(
      'Rename the durable display label for an active run or historical session.',
    )
    .option('--json', 'Output machine-readable JSON.')
    .action(
      async (runRef: string, label: string, options: { json?: boolean }) => {
        const context = await taskContext({ ensureExclusion: false });
        const actor = await resolveCurrentActor(context.root, context.state);
        if (actor.kind !== 'operator')
          throw new Error('Only the operator can rename session labels.');
        if (!runRef.startsWith('run:') || runRef.length === 4)
          throw new Error(
            'Run references must use the canonical run:<id> form.',
          );

        const canonicalRunId = runRef.slice(4);
        const validatedLabel = validateSessionLabel(label);
        const updatedState = await renameSessionLabel(
          context.root,
          canonicalRunId,
          validatedLabel,
        );
        const matchingRun =
          updatedState.runs.find((run) => run.runId === canonicalRunId) ??
          updatedState.agentHistory.find((run) => run.id === canonicalRunId);

        if (options.json) {
          process.stdout.write(
            `${JSON.stringify(
              {
                schemaVersion: 1,
                ok: true,
                runId: canonicalRunId,
                ref: `run:${canonicalRunId}`,
                displayLabel: validatedLabel,
                matchingRun,
              },
              null,
              2,
            )}\n`,
          );
          return;
        }
        process.stdout.write(
          `Updated session label for run:${canonicalRunId} to "${validatedLabel}".\n`,
        );
      },
    );

  return session;
}
