import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAuthenticationCache,
  getAgent,
} from '../../src/agents/registry.js';

let binDir: string;
const originalPath = process.env.PATH;

async function writeFake(name: string, script: string) {
  const file = path.join(binDir, name);
  await writeFile(file, script);
  await chmod(file, 0o755);
}

beforeAll(async () => {
  binDir = await mkdtemp(path.join(tmpdir(), 'rirei-auth-'));
  process.env.PATH = `${binDir}:${originalPath}`;
});

beforeEach(() => clearAuthenticationCache());

afterAll(async () => {
  process.env.PATH = originalPath;
  await rm(binDir, { recursive: true, force: true });
});

describe('provider authentication probes', () => {
  it('reports Claude authenticated from structured JSON', async () => {
    await writeFake(
      'claude',
      `#!/bin/sh
echo '{"loggedIn": true, "authMethod": "firstParty", "apiProvider": "firstParty"}'
`,
    );
    const result = await getAgent('claude').detectAuthentication();
    expect(result).toMatchObject({
      status: 'authenticated',
      confidence: 'high',
      source: 'official_cli_json',
      scopes: [{ providerId: 'firstParty', status: 'authenticated' }],
    });
  });

  it('reports Claude not authenticated from structured JSON', async () => {
    await writeFake(
      'claude',
      `#!/bin/sh
echo '{"loggedIn": false, "authMethod": "none", "apiProvider": "firstParty"}'
`,
    );
    const result = await getAgent('claude').detectAuthentication();
    expect(result.status).toBe('not_authenticated');
    expect(result.confidence).toBe('high');
    expect(result.scopes).toEqual([
      { providerId: 'firstParty', status: 'not_authenticated' },
    ]);
  });

  it('reports unknown for malformed Claude output without guessing', async () => {
    await writeFake('claude', '#!/bin/sh\necho "not valid json at all"\n');
    const result = await getAgent('claude').detectAuthentication();
    expect(result.status).toBe('unknown');
    expect(result.confidence).toBe('low');
    expect(result.source).toBe('official_cli_json');
  });

  it('reports unknown when the Claude probe output is oversized', async () => {
    await writeFake(
      'claude',
      `#!/bin/sh
awk 'BEGIN { for (i = 0; i < 70000; i++) printf "a" }'
`,
    );
    const result = await getAgent('claude').detectAuthentication();
    expect(result.status).toBe('unknown');
    expect(result.confidence).toBe('low');
  });

  it('reports unknown when the Claude probe times out', async () => {
    await writeFake('claude', '#!/bin/sh\nsleep 30\n');
    const result = await getAgent('claude').detectAuthentication();
    expect(result.status).toBe('unknown');
    expect(result.confidence).toBe('low');
  });

  it('parses Claude structured output even when the CLI exits non-zero', async () => {
    await writeFake(
      'claude',
      `#!/bin/sh
echo '{"loggedIn": true, "authMethod": "firstParty", "apiProvider": "firstParty"}'
exit 1
`,
    );
    const result = await getAgent('claude').detectAuthentication();
    expect(result.status).toBe('authenticated');
    expect(result.confidence).toBe('high');
  });

  it('reports unknown when the probe executable is missing', async () => {
    await rm(path.join(binDir, 'claude'), { force: true });
    const isolatedPath = process.env.PATH;
    process.env.PATH = binDir;
    try {
      const result = await getAgent('claude').detectAuthentication();
      expect(result.status).toBe('unknown');
      expect(result.confidence).toBe('low');
    } finally {
      process.env.PATH = isolatedPath;
    }
  });

  it('reads Codex login status from stderr', async () => {
    await writeFake(
      'codex',
      `#!/bin/sh
echo 'Logged in using ChatGPT' >&2
exit 0
`,
    );
    const result = await getAgent('codex').detectAuthentication();
    expect(result).toMatchObject({
      status: 'authenticated',
      confidence: 'medium',
      source: 'official_cli_status',
    });
    expect(result.detail).toBe('Codex CLI reports an active login.');
    expect(result.detail).not.toContain('secret');
  });

  it('reports Codex not authenticated from its status text', async () => {
    await writeFake(
      'codex',
      `#!/bin/sh
echo 'Not logged in. Run codex login.' >&2
exit 0
`,
    );
    const result = await getAgent('codex').detectAuthentication();
    expect(result.status).toBe('not_authenticated');
    expect(result.confidence).toBe('high');
  });

  it('refuses to guess on unrecognized Codex status text', async () => {
    await writeFake(
      'codex',
      `#!/bin/sh
echo 'some entirely unexpected message' >&2
exit 0
`,
    );
    const result = await getAgent('codex').detectAuthentication();
    expect(result.status).toBe('unknown');
    expect(result.confidence).toBe('low');
  });

  it('keeps conservative unknown for providers without a status command', async () => {
    await expect(
      getAgent('gemini').detectAuthentication(),
    ).resolves.toMatchObject({ status: 'unknown', source: 'none' });
    await expect(
      getAgent('antigravity').detectAuthentication(),
    ).resolves.toMatchObject({ status: 'unknown', source: 'none' });
  });
});
