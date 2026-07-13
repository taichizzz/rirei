import { mkdir, readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { relayPath } from '../../src/safety/path-policy.js';
import { appendEvent } from '../../src/state/events.js';
import { createRepository, removeRepository } from '../helpers.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeRepository));
});

describe('events', () => {
  it('appends independently parseable JSONL events', async () => {
    const root = await createRepository();
    directories.push(root);
    await mkdir(relayPath(root), { recursive: true });
    await appendEvent(root, 'task_started', { sessionId: 'one' });
    await appendEvent(root, 'task_started', { sessionId: 'two' });
    const lines = (await readFile(relayPath(root, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1] ?? '{}')).toMatchObject({
      data: { sessionId: 'two' },
    });
  });
});
