import { mkdir } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendTerminalJournal,
  JOURNAL_ENTRY_LIMIT,
  journalFilePath,
  readTerminalJournal,
} from '../../src/state/journal.js';
import { relayPath } from '../../src/safety/path-policy.js';
import { createRepository, removeRepository } from '../helpers.js';

const roots: string[] = [];

async function project(): Promise<string> {
  const root = await createRepository();
  roots.push(root);
  await mkdir(relayPath(root), { recursive: true });
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeRepository));
});

describe('terminal journal', () => {
  it('starts empty and append durable lifecycle entries', async () => {
    const root = await project();
    expect((await readTerminalJournal(root)).entries).toEqual([]);

    await appendTerminalJournal(root, {
      at: '2026-01-01T00:00:00.000Z',
      terminalId: 'terminal-1',
      event: 'created',
      detail: 'claude',
    });
    const journal = await readTerminalJournal(root);
    expect(journal.entries).toHaveLength(1);
    expect(journal.entries[0]).toMatchObject({
      terminalId: 'terminal-1',
      event: 'created',
      detail: 'claude',
    });
    expect(journalFilePath(root)).toMatch(
      /terminal-journal-[0-9a-f]{32}\.json$/,
    );
    expect(JSON.stringify(journal)).not.toContain('prompt');
    expect(JSON.stringify(journal)).not.toContain('terminal output');
    expect(JSON.stringify(journal)).not.toContain('credential');
  });

  it('keeps the journal bounded to the configured limit', async () => {
    const root = await project();
    for (let index = 0; index < JOURNAL_ENTRY_LIMIT + 25; index += 1) {
      await appendTerminalJournal(root, {
        at: '2026-01-01T00:00:00.000Z',
        terminalId: `terminal-${index}`,
        event: 'status',
        detail: 'running',
      });
    }
    const journal = await readTerminalJournal(root);
    expect(journal.entries).toHaveLength(JOURNAL_ENTRY_LIMIT);
    expect(journal.entries[0]?.terminalId).toBe('terminal-25');
  });

  it('rejects events that are not valid lifecycle types', async () => {
    const root = await project();
    await expect(
      appendTerminalJournal(root, {
        at: '2026-01-01T00:00:00.000Z',
        terminalId: 'terminal-1',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        event: 'output' as any,
      }),
    ).rejects.toThrow();
  });

  it('survives a frontend restart by persisting to disk', async () => {
    const root = await project();
    await appendTerminalJournal(root, {
      at: '2026-01-01T00:00:00.000Z',
      terminalId: 'terminal-1',
      event: 'attached',
      detail: 'agent claude started',
    });
    await appendTerminalJournal(root, {
      at: '2026-01-01T00:01:00.000Z',
      terminalId: 'terminal-1',
      event: 'exit',
      detail: 'completed',
    });
    expect(await readTerminalJournal(root)).toMatchObject({
      entries: [
        { terminalId: 'terminal-1', event: 'attached' },
        { terminalId: 'terminal-1', event: 'exit' },
      ],
    });
  });

  it('serializes concurrent appends and redacts secret-like detail', async () => {
    const root = await project();
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        appendTerminalJournal(root, {
          at: new Date(
            Date.parse('2026-01-01T00:00:00.000Z') + index,
          ).toISOString(),
          terminalId: `terminal-${index}`,
          event: 'status',
          detail: index === 0 ? 'api_key=sk-proj-supersecret' : 'running',
        }),
      ),
    );
    const journal = await readTerminalJournal(root);
    expect(journal.entries).toHaveLength(20);
    expect(JSON.stringify(journal)).not.toContain('sk-proj-supersecret');
    expect(
      journal.entries.find((entry) => entry.terminalId === 'terminal-0')
        ?.detail,
    ).toBe('redacted');
  });
});
