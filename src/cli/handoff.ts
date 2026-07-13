import { Command } from 'commander';
import { renderHandoff, taskContext } from '../lifecycle.js';

export function handoffCommand(): Command {
  return new Command('handoff')
    .description('Print a concise provider-independent task handoff')
    .action(async () => {
      const { root, state } = await taskContext();
      process.stdout.write(await renderHandoff(root, state));
    });
}
