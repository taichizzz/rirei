import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

describe('packaged desktop protocol', () => {
  test('registers the rirei scheme with electron-builder', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
    expect(packageJson.build.protocols).toContainEqual({
      name: 'Rirei terminal',
      schemes: ['rirei'],
    });
    expect(packageJson.build.asarUnpack).toEqual([
      'desktop/terminal-daemon.mjs',
      'desktop/terminal-daemon-server.mjs',
      'desktop/terminal-daemon-protocol.mjs',
      'desktop/terminal-control.mjs',
      'desktop/terminal-host.mjs',
      'desktop/node-pty-loader.cjs',
      'desktop/provider-lifecycle-hook.cjs',
      'desktop/codex-lifecycle-wrapper.mjs',
      'desktop/opencode-lifecycle-wrapper.mjs',
      'desktop/pty_bridge.py',
    ]);
    expect(packageJson.build.files).toEqual(
      expect.arrayContaining([
        'desktop/**/*',
        '!desktop/**/__pycache__/**',
        '!desktop/**/*.pyc',
        '!desktop/**/*.pyo',
      ]),
    );
    expect(packageJson.build.extraResources).toEqual(
      expect.arrayContaining([
        { from: 'LICENSE', to: 'LICENSE' },
        { from: 'THIRD_PARTY_NOTICES.md', to: 'THIRD_PARTY_NOTICES.md' },
      ]),
    );
    expect(packageJson.main).toBe('dist/index.cjs');
    expect(packageJson.build.extraMetadata.main).toBe('desktop/main.mjs');
    expect(packageJson.scripts['desktop:dev']).toContain(
      'electron desktop/main.mjs',
    );
  });
});
