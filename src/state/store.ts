import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { relayPath } from '../safety/path-policy.js';
import { relayStateSchema, type RelayState } from './schema.js';

const STATE_FILE = 'state.json';

export async function readState(projectRoot: string): Promise<RelayState> {
  const contents = await readFile(relayPath(projectRoot, STATE_FILE), 'utf8');
  return relayStateSchema.parse(JSON.parse(contents));
}

export async function writeState(
  projectRoot: string,
  state: RelayState,
): Promise<void> {
  const validState = relayStateSchema.parse(state);
  const destination = relayPath(projectRoot, STATE_FILE);
  const temporary = relayPath(
    projectRoot,
    `.${STATE_FILE}.${randomUUID()}.tmp`,
  );
  await writeFile(temporary, `${JSON.stringify(validState, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(temporary, destination);
}
