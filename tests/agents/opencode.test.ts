import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAgent } from '../../src/agents/registry.js';
import { clearAuthenticationCache } from '../../src/agents/registry.js';

let binDir: string;
const originalPath = process.env.PATH;

async function writeFake(name: string, script: string) {
  if (process.platform === 'win32') {
    const shellScript = path.join(binDir, `${name}.sh`);
    await writeFile(shellScript, script);
    await writeFile(
      path.join(binDir, `${name}.cmd`),
      `@echo off\r\nbash "${shellScript}" %*\r\n`,
    );
    return;
  }
  const executable = path.join(binDir, name);
  await writeFile(executable, script);
  await chmod(executable, 0o755);
}

async function removeFake(name: string) {
  await Promise.all(
    process.platform === 'win32'
      ? [
          rm(path.join(binDir, `${name}.cmd`), { force: true }),
          rm(path.join(binDir, `${name}.sh`), { force: true }),
        ]
      : [rm(path.join(binDir, name), { force: true })],
  );
}

beforeAll(async () => {
  binDir = await mkdtemp(path.join(tmpdir(), 'rirei-opencode-'));
  process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;
});

afterAll(async () => {
  process.env.PATH = originalPath;
  await rm(binDir, { recursive: true, force: true });
});

describe('opencode adapter', () => {
  it('parses provider/model lines from `opencode models`', async () => {
    await writeFake(
      'opencode',
      `#!/bin/sh
cat <<'EOF'
anthropic/claude-sonnet-4-6
anthropic/claude-opus-4-6
openai/gpt-5.6-sol
EOF
`,
    );
    const result = await getAgent('opencode').getModels();
    expect(result.status).toBe('available');
    expect(result.source).toBe('opencode models');
    expect(result.values).toEqual([
      { id: 'anthropic/claude-opus-4-6', label: 'anthropic/claude-opus-4-6' },
      {
        id: 'anthropic/claude-sonnet-4-6',
        label: 'anthropic/claude-sonnet-4-6',
      },
      { id: 'openai/gpt-5.6-sol', label: 'openai/gpt-5.6-sol' },
    ]);
  });

  it('reports an error instead of an empty catalog on unparseable models output', async () => {
    await writeFake('opencode', '#!/bin/sh\necho "OpenCode models (cached)"\n');
    const result = await getAgent('opencode').getModels();
    expect(result.status).toBe('error');
    expect(result.values).toEqual([]);
    expect(result.detail).toMatch(/no provider\/model lines/);
  });

  it('reports configured providers from `opencode auth list`', async () => {
    clearAuthenticationCache();
    await writeFake(
      'opencode',
      `#!/bin/sh
printf '✓ anthropic\\nopenai\\n  -  opencode-npm\\n'
`,
    );
    const result = await getAgent('opencode').detectAuthentication();
    expect(result).toMatchObject({
      status: 'configured',
      confidence: 'medium',
      source: 'configured_provider_list',
      scopes: [
        { providerId: 'anthropic', status: 'configured' },
        { providerId: 'openai', status: 'configured' },
        { providerId: 'opencode-npm', status: 'configured' },
      ],
    });
  });

  it('parses ANSI-decorated OpenCode credential rows', async () => {
    clearAuthenticationCache();
    await writeFake(
      'opencode',
      `#!/bin/sh
printf '\\033[0m\n┌  Credentials  \\033[90m~/.local/share/opencode/auth.json\n│\n●  OpenAI  \\033[90moauth\n│\n●  GitHub Copilot  \\033[90moauth\n│\n└  2 credentials\n'
`,
    );

    const result = await getAgent('opencode').detectAuthentication();

    expect(result).toMatchObject({
      status: 'configured',
      scopes: [
        { providerId: 'openai', status: 'configured' },
        { providerId: 'github-copilot', status: 'configured' },
      ],
    });
  });

  it('caches authentication probes for the bounded polling window', async () => {
    clearAuthenticationCache();
    await writeFake(
      'opencode',
      `#!/bin/sh
printf 'anthropic\\n'
`,
    );
    expect((await getAgent('opencode').detectAuthentication()).scopes).toEqual([
      { providerId: 'anthropic', status: 'configured' },
    ]);
    await writeFake('opencode', '#!/bin/sh\nprintf "openai\\n"\n');
    expect((await getAgent('opencode').detectAuthentication()).scopes).toEqual([
      { providerId: 'anthropic', status: 'configured' },
    ]);
  });

  it('reports not authenticated when opencode lists no credentials', async () => {
    clearAuthenticationCache();
    await writeFake('opencode', '#!/bin/sh\necho "No providers configured"\n');
    const result = await getAgent('opencode').detectAuthentication();
    expect(result).toMatchObject({
      status: 'not_authenticated',
      confidence: 'medium',
    });
  });

  it('keeps unknown for unrecognized auth output and missing binaries', async () => {
    clearAuthenticationCache();
    await writeFake('opencode', '#!/bin/sh\necho "unexpected prose"\n');
    const parsed = await getAgent('opencode').detectAuthentication();
    expect(parsed.status).toBe('unknown');
    expect(parsed.confidence).toBe('low');

    await removeFake('opencode');
    clearAuthenticationCache();
    const isolatedPath = process.env.PATH;
    process.env.PATH = binDir;
    try {
      const missing = await getAgent('opencode').detectAuthentication();
      expect(missing.status).toBe('unknown');
      expect(missing.confidence).toBe('low');
    } finally {
      process.env.PATH = isolatedPath;
    }
  });

  it('reports the binary not installed when absent from PATH', async () => {
    await removeFake('opencode');
    const isolatedPath = process.env.PATH;
    process.env.PATH = binDir;
    try {
      const result = await getAgent('opencode').detectInstallation();
      expect(result.status).toBe('not_installed');
    } finally {
      process.env.PATH = isolatedPath;
    }
  });
});
