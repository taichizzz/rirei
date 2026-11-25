import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { readConfig, writeConfig } from '../../src/config/loader.js';
import { readState } from '../../src/state/store.js';
import { retrievalProject } from './retrieval-helpers.js';

const execute = promisify(execFile);
const source = fileURLToPath(new URL('../../src/index.ts', import.meta.url));
const compiled = fileURLToPath(
  new URL('../../dist/index.cjs', import.meta.url),
);
const loader = new URL(
  '../../node_modules/tsx/dist/loader.mjs',
  import.meta.url,
).href;

describe('handoff profile preview CLI', () => {
  it.each(['source', 'compiled'] as const)(
    'renders named candidates without changing state or launching a provider (%s)',
    async (mode) => {
      const { root, record } = await retrievalProject();
      await record('Keep the public interface.');
      const relay = (...args: string[]) =>
        execute(
          process.execPath,
          mode === 'source'
            ? ['--import', loader, source, ...args]
            : [compiled, ...args],
          { cwd: root },
        );
      const before = await readFile(
        path.join(root, '.relay/state.json'),
        'utf8',
      );
      const baseline = await relay('handoff', '--json');
      expect(
        (await relay('handoff', '--profile', 'control', '--json')).stdout,
      ).toBe(baseline.stdout);
      const candidate = JSON.parse(
        (await relay('handoff', '--profile', 'stable-focused', '--json'))
          .stdout,
      );
      expect(candidate.policy).toMatchObject({
        requested: 'stable-focused',
        applied: true,
        cacheBenefit: 'unmeasured',
      });
      expect(candidate.text).toContain('RECEIVER OUTPUT POLICY v1');
      expect(candidate.text).toContain('Keep the public interface.');
      expect(candidate.budget.usedCharacters).toBe(candidate.text.length);
      await expect(relay('handoff', '--profile', 'unknown')).rejects.toThrow(
        'Unknown handoff profile',
      );
      await expect(
        relay('switch', 'codex', '--profile', 'stable-focused', '--yes'),
      ).rejects.toThrow('unknown option');
      expect((await readState(root)).agentHistory).toEqual([]);
      expect(await readFile(path.join(root, '.relay/state.json'), 'utf8')).toBe(
        before,
      );
      const config = await readConfig(root);
      await writeConfig(root, {
        ...config,
        handoff: {
          ...config.handoff,
          maxCharacters: 240,
          targetCharacters: 240,
          maxTokens: 60,
          targetTokens: 60,
        },
      });
      const fallback = await relay('handoff', '--profile', 'focused-output');
      expect(fallback.stderr).toContain('kept control rendering');
      expect(fallback.stdout).not.toContain('RECEIVER OUTPUT POLICY');
    },
  );
});
