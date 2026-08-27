import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import spawn from 'cross-spawn';
import type { ProcessResult } from '../agents/adapter.js';
import type {
  ProcessEvent,
  ProcessHandle,
  ProcessHost,
  ProcessListener,
  ProcessStartRequest,
  Unsubscribe,
} from './process-host.js';

interface HostedProcess {
  child: ChildProcess;
  listeners: Set<ProcessListener>;
  result?: ProcessResult;
  terminationIntent: ProcessResult['terminationIntent'];
}

/** Process host used by the scriptable CLI, preserving inherited terminal I/O. */
export class InheritedProcessHost implements ProcessHost {
  private readonly processes = new Map<string, HostedProcess>();
  private controllerIntent: ProcessResult['terminationIntent'] = 'none';

  setTerminationIntent(intent: ProcessResult['terminationIntent']): void {
    this.controllerIntent = intent;
    for (const hosted of this.processes.values())
      hosted.terminationIntent = intent;
  }

  async start(request: ProcessStartRequest): Promise<ProcessHandle> {
    const id = randomUUID();
    const args =
      process.platform === 'win32'
        ? request.command.args.map((argument) =>
            argument.replace(/\r\n?|\n/g, ' '),
          )
        : request.command.args;
    const child = spawn(request.command.executable, args, {
      cwd: request.cwd,
      env: request.env ?? process.env,
      stdio: 'inherit',
    });
    const hosted: HostedProcess = {
      child,
      listeners: new Set(),
      terminationIntent: this.controllerIntent,
    };
    this.processes.set(id, hosted);
    let finalized = false;
    const finalize = (result: ProcessResult): void => {
      if (finalized) return;
      finalized = true;
      hosted.result = result;
      this.publish(hosted, { type: 'exit', result });
    };
    child.once('error', (error) =>
      finalize({
        exitCode: null,
        signal: null,
        spawnErrorCode:
          typeof (error as NodeJS.ErrnoException).code === 'string'
            ? (error as NodeJS.ErrnoException).code
            : undefined,
        terminationIntent: hosted.terminationIntent,
        observations: [],
        stdout: '',
        stderr: '',
      }),
    );
    child.once('close', (exitCode, signal) =>
      finalize({
        exitCode,
        signal,
        terminationIntent: hosted.terminationIntent,
        observations: [],
        stdout: '',
        stderr: '',
      }),
    );
    return { id };
  }

  async write(handleId: string, data: Uint8Array): Promise<void> {
    const child = this.requireProcess(handleId).child;
    if (!child.stdin?.writable)
      throw new Error(
        'This process host does not expose a writable stdin pipe.',
      );
    child.stdin.write(data);
  }

  async resize(handleId: string, columns: number, rows: number): Promise<void> {
    this.requireProcess(handleId);
    void columns;
    void rows;
    // The inherited terminal owns its own dimensions.
  }

  async interrupt(handleId: string): Promise<void> {
    const hosted = this.requireProcess(handleId);
    hosted.terminationIntent = 'user_interrupt';
    hosted.child.kill('SIGINT');
  }

  async stop(handleId: string): Promise<void> {
    const hosted = this.requireProcess(handleId);
    hosted.terminationIntent = 'user_stop';
    hosted.child.kill('SIGTERM');
  }

  subscribe(handleId: string, listener: ProcessListener): Unsubscribe {
    const hosted = this.requireProcess(handleId);
    hosted.listeners.add(listener);
    if (hosted.result)
      queueMicrotask(() => {
        if (hosted.listeners.has(listener) && hosted.result)
          listener({ type: 'exit', result: hosted.result });
      });
    return () => {
      hosted.listeners.delete(listener);
      this.collect(handleId, hosted);
    };
  }

  private publish(hosted: HostedProcess, event: ProcessEvent): void {
    for (const listener of hosted.listeners) listener(event);
  }

  private requireProcess(handleId: string): HostedProcess {
    const hosted = this.processes.get(handleId);
    if (!hosted) throw new Error(`Unknown process handle: ${handleId}.`);
    return hosted;
  }

  private collect(handleId: string, hosted: HostedProcess): void {
    if (hosted.result && hosted.listeners.size === 0)
      this.processes.delete(handleId);
  }
}
