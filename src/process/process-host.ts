import type { CommandSpec, ProcessResult } from '../agents/adapter.js';

export interface ProcessStartRequest {
  command: CommandSpec;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export interface ProcessHandle {
  id: string;
}

export type ProcessEvent =
  | { type: 'data'; stream: 'stdout' | 'stderr'; data: Uint8Array }
  | { type: 'exit'; result: ProcessResult };

export type ProcessListener = (event: ProcessEvent) => void;
export type Unsubscribe = () => void;

/** Frontend-independent ownership boundary for provider processes. */
export interface ProcessHost {
  start(request: ProcessStartRequest): Promise<ProcessHandle>;
  write(handleId: string, data: Uint8Array): Promise<void>;
  resize(handleId: string, columns: number, rows: number): Promise<void>;
  interrupt(handleId: string): Promise<void>;
  stop(handleId: string): Promise<void>;
  subscribe(handleId: string, listener: ProcessListener): Unsubscribe;
}
