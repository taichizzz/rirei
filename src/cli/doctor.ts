import { access, constants } from 'node:fs/promises';
import { Command } from 'commander';
import {
  conservativeAuthenticationStatus,
  detectExecutable,
  registeredAgents,
} from '../agents/registry.js';
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
        const authentication = conservativeAuthenticationStatus();
        const installed = installation.status === 'ready' ? 'Yes' : 'No';
        const auth =
          installation.status === 'ready'
            ? authentication.status
            : 'unavailable';
        process.stdout.write(
          `${agent.displayName.padEnd(8)}${installed.padEnd(17)}${auth.padEnd(16)}Unknown      Unknown\n`,
        );
      }
    });
}
