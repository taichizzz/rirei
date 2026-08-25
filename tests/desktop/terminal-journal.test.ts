import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendTerminalJournal,
  listTerminalJournalProjects,
} from '../../desktop/terminal-journal.mjs';

describe('terminal journal project discovery', () => {
  let directory: string;
  let previousDataHome: string | undefined;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'rirei-journals-'));
    previousDataHome = process.env.RIREI_DATA_HOME;
    process.env.RIREI_DATA_HOME = directory;
  });

  afterEach(async () => {
    if (previousDataHome === undefined) delete process.env.RIREI_DATA_HOME;
    else process.env.RIREI_DATA_HOME = previousDataHome;
    await rm(directory, { recursive: true, force: true });
  });

  it('recovers hash-verified project roots from durable journals', async () => {
    await appendTerminalJournal('/tmp/project', {
      at: '2026-08-24T00:00:00.000Z',
      terminalId: 'terminal-1',
      event: 'created',
    });

    await expect(listTerminalJournalProjects()).resolves.toEqual([
      '/tmp/project',
    ]);
  });

  it('ignores journals whose filename does not match their project root', async () => {
    await writeFile(
      path.join(
        directory,
        'terminal-journal-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json',
      ),
      JSON.stringify({
        schemaVersion: 1,
        entries: [
          {
            at: '2026-08-24T00:00:00.000Z',
            terminalId: 'terminal-1',
            event: 'created',
            projectRoot: '/tmp/injected',
            controllerInstanceId: 'terminal-1',
            createdAt: '2026-08-24T00:00:00.000Z',
            lastActivityAt: '2026-08-24T00:00:00.000Z',
            expectedStatus: 'starting',
          },
        ],
      }),
    );

    await expect(listTerminalJournalProjects()).resolves.toEqual([]);
  });
});
