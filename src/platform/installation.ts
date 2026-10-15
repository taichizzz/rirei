import { isExecutableInstalled } from './executable.js';
import {
  resolveCcusageBinary,
  PINNED_CCUSAGE_VERSION,
} from '../token-usage/resolve.js';
import { RIREI_VERSION } from '../version.js';

/** Checks package prerequisites without opening project state or agent logs. */
export async function inspectInstallation() {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  const nodeReady = major > 22 || (major === 22 && minor >= 12);
  const gitReady = await isExecutableInstalled('git');
  let ptyReady = false;
  try {
    const pty = await import('node-pty');
    ptyReady = typeof (pty.spawn ?? pty.default?.spawn) === 'function';
  } catch {
    // Native addon load failures have a fixed diagnostic, with no local paths.
  }
  const ccusage = resolveCcusageBinary();
  const ccusageReady = ccusage?.version === PINNED_CCUSAGE_VERSION;
  return {
    schemaVersion: 1 as const,
    version: RIREI_VERSION,
    platform: process.platform,
    arch: process.arch,
    ok: nodeReady && gitReady && ptyReady && ccusageReady,
    node: {
      status: nodeReady ? 'ready' : 'error',
      version: process.versions.node,
    },
    git: { status: gitReady ? 'ready' : 'not_installed' },
    terminal: {
      status: ptyReady ? 'ready' : 'error',
      backend: process.platform === 'win32' ? 'ConPTY' : 'PTY',
      ...(ptyReady ? {} : { reason: 'native_terminal_unavailable' }),
    },
    tokenCollector: {
      status: ccusageReady ? 'ready' : 'error',
      version: ccusage?.version ?? null,
      pathClass: ccusage?.pathClass ?? null,
    },
    next: 'Open a Git project and run relay tui.',
  };
}
