import { readFile, writeFile } from 'node:fs/promises';
import { relayPath } from '../safety/path-policy.js';
import { configSchema, type RelayConfig } from './schema.js';

const CONFIG_FILE = 'config.json';

export async function readConfig(projectRoot: string): Promise<RelayConfig> {
  const contents = await readFile(relayPath(projectRoot, CONFIG_FILE), 'utf8');
  return configSchema.parse(JSON.parse(contents));
}

export async function writeConfig(
  projectRoot: string,
  config: RelayConfig,
): Promise<void> {
  const validConfig = configSchema.parse(config);
  await writeFile(
    relayPath(projectRoot, CONFIG_FILE),
    `${JSON.stringify(validConfig, null, 2)}\n`,
    {
      encoding: 'utf8',
      mode: 0o600,
    },
  );
}
