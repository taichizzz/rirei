import { appendFile, mkdir } from 'node:fs/promises';
import { relayPath } from '../safety/path-policy.js';

export async function appendEvent(
  projectRoot: string,
  type: string,
  data: Record<string, unknown>,
): Promise<void> {
  const eventsPath = relayPath(projectRoot, 'events.jsonl');
  await mkdir(relayPath(projectRoot), { recursive: true, mode: 0o700 });
  const event = JSON.stringify({ type, at: new Date().toISOString(), data });
  await appendFile(eventsPath, `${event}\n`, { encoding: 'utf8', mode: 0o600 });
}
