import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { rireiDataHome } from '../platform/runtime-paths.js';

export const OPT_IN_FILENAME = 'token-usage-opt-in.json';

export interface TokenUsageOptInRecord {
  optIn: boolean;
  updatedAt: string;
}

export function optInNotice(): string {
  return 'Local agent logs are processed on this computer by bundled ccusage to extract token counts. Nothing is uploaded; no prompts or conversations are read into Rirei.';
}

export async function getTokenUsageOptIn(options?: {
  home?: string;
}): Promise<boolean> {
  const dataDir = rireiDataHome(options);
  const filePath = path.join(dataDir, OPT_IN_FILENAME);
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as TokenUsageOptInRecord;
    return parsed.optIn === true;
  } catch {
    return false;
  }
}

export async function setTokenUsageOptIn(
  optIn: boolean,
  options?: { home?: string },
): Promise<void> {
  const dataDir = rireiDataHome(options);
  await mkdir(dataDir, { recursive: true });
  const filePath = path.join(dataDir, OPT_IN_FILENAME);
  const record: TokenUsageOptInRecord = {
    optIn,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(filePath, JSON.stringify(record, null, 2), 'utf8');
}
