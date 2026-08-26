import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isExecutableInstalled,
  pathextList,
  resolveExecutable,
} from '../../src/platform/executable.js';

describe('executable resolution', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'rirei-exec-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('parses PATHEXT with defaults and environment overrides', () => {
    expect(pathextList({ PATHEXT: '.EXE;.CMD;.BAT' })).toEqual([
      '.EXE',
      '.CMD',
      '.BAT',
    ]);
    expect(pathextList({ PATHEXT: ' .com ; .exe ' })).toEqual(['.com', '.exe']);
    expect(pathextList({}).length).toBeGreaterThan(0);
  });

  it('resolves executables on Unix via PATH and X_OK permission', async () => {
    const scriptPath = path.join(tempDir, 'sample-tool');
    await writeFile(scriptPath, '#!/bin/sh\necho "hello"\n', 'utf8');
    await chmod(scriptPath, 0o755);

    const resolved = await resolveExecutable('sample-tool', {
      platform: 'darwin',
      env: { PATH: tempDir },
    });
    expect(resolved).toBe(scriptPath);

    const nonExecutable = path.join(tempDir, 'not-executable');
    await writeFile(nonExecutable, 'data', 'utf8');
    await chmod(nonExecutable, 0o644);

    const unexecutable = await resolveExecutable('not-executable', {
      platform: 'darwin',
      env: { PATH: tempDir },
    });
    expect(unexecutable).toBeNull();
  });

  it('resolves Windows executables with PATHEXT extensions', async () => {
    const cmdPath = path.join(tempDir, 'claude.cmd');
    await writeFile(cmdPath, '@echo off\n', 'utf8');

    const resolved = await resolveExecutable('claude', {
      platform: 'win32',
      env: { PATH: tempDir, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
    });
    expect(resolved).toBe(cmdPath);

    const isInstalled = await isExecutableInstalled('claude', {
      platform: 'win32',
      env: { PATH: tempDir, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
    });
    expect(isInstalled).toBe(true);

    const missing = await resolveExecutable('missing-tool', {
      platform: 'win32',
      env: { PATH: tempDir },
    });
    expect(missing).toBeNull();
  });

  it('resolves direct paths with separators', async () => {
    const binPath = path.join(tempDir, 'direct-bin');
    await writeFile(binPath, '#!/bin/sh\n', 'utf8');
    await chmod(binPath, 0o755);

    const resolved = await resolveExecutable(binPath, {
      platform: 'darwin',
    });
    expect(resolved).toBe(binPath);
  });
});
