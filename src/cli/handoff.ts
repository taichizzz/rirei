import { Command } from 'commander';
import { renderHandoffDocument, taskContext } from '../lifecycle.js';

export function handoffCommand(): Command {
  return new Command('handoff')
    .description('Print a concise provider-independent task handoff')
    .option('--json', 'print the portable capsule and budget as JSON')
    .action(async (options: { json?: boolean }) => {
      const { root, state } = await taskContext();
      const handoff = await renderHandoffDocument(root, state);
      process.stdout.write(
        options.json ? `${JSON.stringify(handoff, null, 2)}\n` : handoff.text,
      );
    });
}
