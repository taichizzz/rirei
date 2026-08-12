import { access, constants, mkdir, stat } from 'node:fs/promises';
import { Command } from 'commander';
import { defaultConfig } from '../config/schema.js';
import { writeConfig } from '../config/loader.js';
import {
  discoverRepository,
  installRelayLocalExclusion,
} from '../git/repository.js';
import { RELAY_DIRECTORY, relayPath } from '../safety/path-policy.js';

export function initCommand(): Command {
  return new Command('init')
    .description('Initialize Relay in the current Git repository')
    .action(async () => {
      const projectRoot = await discoverRepository(process.cwd());
      if (!projectRoot) {
        throw new Error('Relay must be initialized inside a Git repository.');
      }

      await installRelayLocalExclusion(projectRoot);

      const directory = relayPath(projectRoot);
      try {
        const existing = await stat(directory);
        if (existing.isDirectory()) {
          throw new Error(
            `${RELAY_DIRECTORY} already exists; refusing to overwrite Relay state.`,
          );
        }
        throw new Error(`${RELAY_DIRECTORY} exists but is not a directory.`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }

      await mkdir(directory, { mode: 0o700 });
      await mkdir(relayPath(projectRoot, 'checkpoints'), { mode: 0o700 });
      await mkdir(relayPath(projectRoot, 'test-output'), { mode: 0o700 });
      await writeConfig(projectRoot, defaultConfig);
      await access(directory, constants.W_OK);

      process.stdout.write(`Initialized Relay in ${projectRoot}\n`);
      process.stdout.write(
        'Generated events, checkpoints, and test output should be ignored; task and decision files may be committed later.\n',
      );
    });
}
