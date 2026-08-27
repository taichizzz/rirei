import { spawn as ptySpawn, type IPty } from 'node-pty';
import {
  killProcessTree,
  type TerminalInterruptIntent,
} from '../platform/process-control.js';

export interface TerminalExit {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly error?: string | null;
}

export interface TerminalHostOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
  useConpty?: boolean;
}

export interface TerminalHost {
  readonly pid: number;
  write(data: Uint8Array | string): Promise<void>;
  resize(cols: number, rows: number): void;
  interrupt(intent: TerminalInterruptIntent): Promise<void>;
  terminate(): Promise<void>;
  killTree(): Promise<void>;
  onData(listener: (data: Uint8Array) => void): () => void;
  onExit(listener: (result: TerminalExit) => void): () => void;
}

export class NodePtyTerminalHost implements TerminalHost {
  private readonly ptyProcess: IPty;
  private readonly dataListeners = new Set<(data: Uint8Array) => void>();
  private readonly exitListeners = new Set<(result: TerminalExit) => void>();
  private disposed = false;

  constructor(
    executable: string,
    args: string[],
    options: TerminalHostOptions,
  ) {
    const cols = Math.max(1, options.cols ?? 80);
    const rows = Math.max(1, options.rows ?? 24);

    this.ptyProcess = ptySpawn(executable, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: options.cwd,
      env: (options.env ?? process.env) as Record<string, string>,
      useConpty: options.useConpty ?? process.platform === 'win32',
    });

    this.ptyProcess.onData((chunk: string) => {
      if (this.disposed) return;
      const buffer = Buffer.from(chunk, 'utf8');
      for (const listener of this.dataListeners) {
        try {
          listener(buffer);
        } catch {
          // Safe listener dispatch
        }
      }
    });

    this.ptyProcess.onExit((event: { exitCode: number; signal?: number }) => {
      if (this.disposed) return;
      this.disposed = true;
      if (process.platform === 'win32') {
        try {
          this.ptyProcess.kill();
        } catch {
          // The process exited; this only releases remaining ConPTY handles.
        }
      }
      const result: TerminalExit = {
        exitCode: Number.isInteger(event.exitCode) ? event.exitCode : null,
        signal: event.signal ? String(event.signal) : null,
        error: null,
      };
      for (const listener of this.exitListeners) {
        try {
          listener(result);
        } catch {
          // Safe listener dispatch
        }
      }
    });
  }

  get pid(): number {
    return this.ptyProcess.pid;
  }

  async write(data: Uint8Array | string): Promise<void> {
    if (this.disposed) throw new Error('Terminal process has exited.');
    const text =
      typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
    this.ptyProcess.write(text);
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    try {
      this.ptyProcess.resize(Math.max(1, cols), Math.max(1, rows));
    } catch {
      // Safe resize on shutdown
    }
  }

  async interrupt(intent: TerminalInterruptIntent): Promise<void> {
    if (this.disposed) return;
    if (process.platform === 'win32') {
      if (intent === 'user_interrupt') {
        this.ptyProcess.write('\x03');
      } else {
        await killProcessTree(this.ptyProcess.pid, {
          force: false,
          platform: 'win32',
        });
      }
    } else {
      try {
        process.kill(
          this.ptyProcess.pid,
          intent === 'user_stop' ? 'SIGTERM' : 'SIGINT',
        );
      } catch {
        // Process might already be gone
      }
    }
  }

  async terminate(): Promise<void> {
    if (this.disposed) return;
    await killProcessTree(this.ptyProcess.pid, { force: false });
  }

  async killTree(): Promise<void> {
    if (this.disposed) return;
    await killProcessTree(this.ptyProcess.pid, { force: true });
  }

  onData(listener: (data: Uint8Array) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onExit(listener: (result: TerminalExit) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }
}

/**
 * Factory function to create a terminal host using node-pty.
 */
export function createTerminalHost(
  executable: string,
  args: string[],
  options: TerminalHostOptions,
): TerminalHost {
  return new NodePtyTerminalHost(executable, args, options);
}
