import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  activityFilePath,
  activitySourcesFilePath,
  daemonDescriptorPath,
  journalFilePath,
  rireiDataHome,
} from '../../src/platform/runtime-paths.js';

describe('runtime paths', () => {
  const fakeHome = '/Users/testuser';

  it('respects RIREI_DATA_HOME absolute override across platforms', () => {
    const override = '/custom/data/home';
    expect(
      rireiDataHome({
        platform: 'darwin',
        home: fakeHome,
        env: { RIREI_DATA_HOME: override },
      }),
    ).toBe(path.posix.resolve(override));

    expect(
      rireiDataHome({
        platform: 'win32',
        home: 'C:\\Users\\testuser',
        env: { RIREI_DATA_HOME: 'D:\\Custom\\Data' },
      }),
    ).toBe(path.win32.resolve('D:\\Custom\\Data'));
  });

  it('resolves relative RIREI_DATA_HOME against home directory', () => {
    expect(
      rireiDataHome({
        platform: 'darwin',
        home: fakeHome,
        env: { RIREI_DATA_HOME: '.custom-rirei' },
      }),
    ).toBe(path.posix.resolve(fakeHome, '.custom-rirei'));
  });

  it('resolves macOS default to Library/Application Support/Rirei', () => {
    expect(
      rireiDataHome({
        platform: 'darwin',
        home: fakeHome,
        env: {},
      }),
    ).toBe(
      path.posix.join(fakeHome, 'Library', 'Application Support', 'Rirei'),
    );
  });

  it('resolves Windows default using LOCALAPPDATA', () => {
    expect(
      rireiDataHome({
        platform: 'win32',
        home: 'C:\\Users\\testuser',
        env: { LOCALAPPDATA: 'C:\\Users\\testuser\\AppData\\Local' },
      }),
    ).toBe(path.win32.join('C:\\Users\\testuser\\AppData\\Local', 'Rirei'));
  });

  it('resolves Windows fallback when LOCALAPPDATA is unset', () => {
    expect(
      rireiDataHome({
        platform: 'win32',
        home: 'C:\\Users\\testuser',
        env: {},
      }),
    ).toBe(path.win32.join('C:\\Users\\testuser', 'AppData', 'Local', 'Rirei'));
  });

  it('resolves Linux default using XDG_DATA_HOME', () => {
    expect(
      rireiDataHome({
        platform: 'linux',
        home: fakeHome,
        env: { XDG_DATA_HOME: '/var/custom/share' },
      }),
    ).toBe(path.posix.join('/var/custom/share', 'rirei'));
  });

  it('resolves Linux fallback to ~/.local/share/rirei', () => {
    expect(
      rireiDataHome({
        platform: 'linux',
        home: fakeHome,
        env: {},
      }),
    ).toBe(path.posix.join(fakeHome, '.local', 'share', 'rirei'));
  });

  it('builds activity, journal, and descriptor file paths', () => {
    const opts = { platform: 'darwin' as const, home: fakeHome, env: {} };
    const base = path.posix.join(
      fakeHome,
      'Library',
      'Application Support',
      'Rirei',
    );

    expect(activityFilePath(opts)).toBe(path.posix.join(base, 'activity.json'));
    expect(activitySourcesFilePath(opts)).toBe(
      path.posix.join(base, 'activity-sources.json'),
    );
    expect(journalFilePath('abc12345', opts)).toBe(
      path.posix.join(base, 'terminal-journal-abc12345.json'),
    );
    expect(daemonDescriptorPath(base, opts)).toBe(
      path.posix.join(base, 'terminal-daemon-v1.json'),
    );
  });
});
