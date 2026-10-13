import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getTokenUsageOptIn,
  optInNotice,
  setTokenUsageOptIn,
} from '../../src/token-usage/opt-in.js';

const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeTmpDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  directories.push(dir);
  vi.stubEnv('RIREI_DATA_HOME', path.join(dir, 'data'));
  return dir;
}

describe('token usage opt-in', () => {
  it('defaults to false when no opt-in file exists', async () => {
    const home = await makeTmpDir('opt-in-empty-');
    const optedIn = await getTokenUsageOptIn({ home });
    expect(optedIn).toBe(false);
  });

  it('persists opt-in true and retrieves it accurately', async () => {
    const home = await makeTmpDir('opt-in-true-');
    await setTokenUsageOptIn(true, { home });
    const optedIn = await getTokenUsageOptIn({ home });
    expect(optedIn).toBe(true);
  });

  it('persists opt-in false when user opts out', async () => {
    const home = await makeTmpDir('opt-in-false-');
    await setTokenUsageOptIn(true, { home });
    expect(await getTokenUsageOptIn({ home })).toBe(true);
    await setTokenUsageOptIn(false, { home });
    expect(await getTokenUsageOptIn({ home })).toBe(false);
  });

  it('provides a transparent notice explaining local processing', () => {
    const notice = optInNotice();
    expect(notice).toContain('Local agent logs');
    expect(notice).toContain('Nothing is uploaded');
  });
});
