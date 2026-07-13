import path from 'node:path';

export const RELAY_DIRECTORY = '.relay';

export function relayPath(projectRoot: string, ...segments: string[]): string {
  const root = path.resolve(projectRoot, RELAY_DIRECTORY);
  const candidate = path.resolve(root, ...segments);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error('Relay state paths must remain within .relay.');
  }
  return candidate;
}
