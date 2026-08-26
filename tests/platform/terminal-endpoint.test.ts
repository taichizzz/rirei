import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cleanupEndpoint,
  daemonEndpoint,
  isSafeDescriptorPermissions,
  prepareEndpoint,
} from '../../src/platform/terminal-endpoint.js';

describe('terminal endpoints', () => {
  it('generates Windows named pipe shape', () => {
    const endpoint = daemonEndpoint({
      hash: 'deadbeef1234',
      platform: 'win32',
    });
    expect(endpoint).toEqual({
      kind: 'named_pipe',
      path: '\\\\.\\pipe\\rirei-deadbeef1234-pty-v1',
    });
  });

  it('generates Unix socket shape with uid and tmp directory', () => {
    const endpoint = daemonEndpoint({
      hash: 'deadbeef1234',
      platform: 'darwin',
      tmpDir: '/tmp',
      uid: 501,
    });
    expect(endpoint).toEqual({
      kind: 'socket',
      path: path.join('/tmp', 'rirei-501-deadbeef1234', 'pty-v1.sock'),
    });
  });

  it('validates safe descriptor permissions on Unix', () => {
    const validUnix = {
      isFile: () => true,
      isSymbolicLink: () => false,
      mode: 0o100600,
      uid: 501,
    };
    expect(isSafeDescriptorPermissions(validUnix, 'darwin', 501)).toBe(true);

    const groupReadable = {
      isFile: () => true,
      isSymbolicLink: () => false,
      mode: 0o100640,
      uid: 501,
    };
    expect(isSafeDescriptorPermissions(groupReadable, 'darwin', 501)).toBe(
      false,
    );

    const wrongOwner = {
      isFile: () => true,
      isSymbolicLink: () => false,
      mode: 0o100600,
      uid: 1000,
    };
    expect(isSafeDescriptorPermissions(wrongOwner, 'darwin', 501)).toBe(false);

    const symlink = {
      isFile: () => false,
      isSymbolicLink: () => true,
      mode: 0o100600,
      uid: 501,
    };
    expect(isSafeDescriptorPermissions(symlink, 'darwin', 501)).toBe(false);
  });

  it('validates safe descriptor permissions on Windows without POSIX mode rejection', () => {
    const windowsFile = {
      isFile: () => true,
      isSymbolicLink: () => false,
      mode: 0o100666,
    };
    expect(isSafeDescriptorPermissions(windowsFile, 'win32')).toBe(true);

    const windowsSymlink = {
      isFile: () => true,
      isSymbolicLink: () => true,
      mode: 0o100666,
    };
    expect(isSafeDescriptorPermissions(windowsSymlink, 'win32')).toBe(false);
  });

  it('handles prepareEndpoint and cleanupEndpoint for named pipes', async () => {
    const pipeEndpoint = daemonEndpoint({
      hash: 'unittesthash99',
      platform: 'win32',
    });
    // Named pipes not currently listening should pass prepareEndpoint cleanly
    await expect(prepareEndpoint(pipeEndpoint)).resolves.toBeUndefined();
    await expect(cleanupEndpoint(pipeEndpoint)).resolves.toBeUndefined();
  });
});
