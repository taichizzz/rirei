import { Command } from 'commander';
import { agentCatalog } from '../agents/registry.js';

export function agentsCommand(): Command {
  return new Command('agents')
    .description('Show installed agents and model/effort capabilities')
    .option('--json', 'print machine-readable JSON')
    .action(async (options: { json?: boolean }) => {
      const agents = await agentCatalog();
      if (options.json) {
        process.stdout.write(`${JSON.stringify({ agents }, null, 2)}\n`);
        return;
      }
      for (const agent of agents) {
        process.stdout.write(
          `${agent.displayName}: ${agent.installed ? agent.version || 'installed' : 'not installed'}\n`,
        );
      }
    });
}
