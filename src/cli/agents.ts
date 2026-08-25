import { Command } from 'commander';
import { agentCatalog } from '../agents/registry.js';

export function agentsCommand(): Command {
  return new Command('agents')
    .description('Show installed agents, model capabilities, and auth status')
    .option('--json', 'print machine-readable JSON')
    .action(async (options: { json?: boolean }) => {
      const agents = await agentCatalog();
      if (options.json) {
        process.stdout.write(
          `${JSON.stringify({ schemaVersion: 2, agents }, null, 2)}\n`,
        );
        return;
      }
      for (const agent of agents) {
        process.stdout.write(
          `${agent.displayName}: ${agent.installed ? agent.version || 'installed' : 'not installed'} (auth: ${agent.authentication?.status ?? 'unavailable'})\n`,
        );
      }
    });
}
