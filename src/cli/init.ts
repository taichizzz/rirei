import { Command } from 'commander';
import { initializeProject } from '../application/project-setup.js';

export function initCommand(): Command {
  return new Command('init')
    .description('Initialize Relay in the current Git repository')
    .action(async () => {
      const projectRoot = await initializeProject(process.cwd());

      process.stdout.write(`Initialized Relay in ${projectRoot}\n`);
      process.stdout.write(
        'Generated events, checkpoints, and test output should be ignored; task and decision files may be committed later.\n',
      );
    });
}
