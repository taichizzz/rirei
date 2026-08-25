import { access, constants } from 'node:fs/promises';
import { Command } from 'commander';
import { detectExecutable, registeredAgents } from '../agents/registry.js';
import { discoverRepository } from '../git/repository.js';
import { relayPath } from '../safety/path-policy.js';

export function doctorCommand(): Command {
  return new Command('doctor')
    .description('Inspect local Relay prerequisites')
    .action(async () => {
      const projectRoot = await discoverRepository(process.cwd());
      const git = projectRoot ? 'ready' : 'error (not in a repository)';
      let relay = 'not initialized';
      if (projectRoot) {
        try {
          await access(relayPath(projectRoot), constants.W_OK);
          relay = 'writable';
        } catch {
          relay = 'not writable or not initialized';
        }
      }
      process.stdout.write(
        `Git: ${git}\nNode.js: ${process.version}\nRelay: ${relay}\n\n`,
      );
      process.stdout.write(
        'Agent   Installed        Authentication  Interactive  Headless\n',
      );
      for (const agent of registeredAgents()) {
        const installation = await detectExecutable(agent.executable);
        const installed = installation.status === 'ready';
        const authentication = installed
          ? await agent.detectAuthentication()
          : undefined;
        process.stdout.write(
          `${agent.displayName.padEnd(8)}${(installed ? 'Yes' : 'No').padEnd(17)}${(installed
            ? (authentication?.status ?? 'unavailable')
            : 'unavailable'
          ).padEnd(
            16,
          )}${(agent.capabilities.interactive ? 'Yes' : 'No').padEnd(12)}${
            agent.capabilities.headless ? 'Yes' : 'No'
          }\n`,
        );
      }
    });
}
