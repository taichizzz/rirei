declare module '*/desktop/terminal-daemon-server.mjs' {
  export function runTerminalDaemon(options: Record<string, unknown>): Promise<{
    close: (opts?: { stopActive?: boolean }) => Promise<void>;
  }>;
  export function daemonSocketPath(runtimeRoot: string): string;
}

declare module '*/desktop/terminal-daemon-client.mjs' {
  export class TerminalDaemonClient {
    constructor(options: Record<string, unknown>);
    connected: boolean;
    connect(): Promise<void>;
    connectOrStart(): Promise<void>;
    disconnect(): void;
    start(
      options: Record<string, unknown>,
    ): Promise<{ id: string; status: string }>;
    stop(terminalId: string): Promise<unknown>;
    attach(
      terminalId: string,
      cursor?: number,
    ): Promise<{ data: string; startCursor: number; endCursor: number }>;
    detach(terminalId: string): Promise<{ ok: boolean }>;
    write(
      terminalId: string,
      data: Uint8Array | string,
    ): Promise<{ ok: boolean }>;
    resize(
      terminalId: string,
      size: { cols: number; rows: number },
    ): Promise<unknown>;
    inspect(terminalId: string): Promise<unknown>;
    refreshInventory(): Promise<
      Array<{
        id: string;
        provider: string;
        project: string;
        workspaceId: string;
        branchLabel: string;
        status: string;
        attentionKind?: string | null;
        activeRuntimeSeconds?: number;
      }>
    >;
    on(
      event: 'output_available',
      listener: (event: { terminalId: string; nextCursor: number }) => void,
    ): void;
    on(
      event: 'exit',
      listener: (event: {
        terminalId?: string;
        terminal?: { id: string };
      }) => void,
    ): void;
    on(event: 'disconnected', listener: () => void): void;
    on(event: string, listener: (arg: never) => void): void;
    removeListener(
      event: 'output_available',
      listener: (event: { terminalId: string; nextCursor: number }) => void,
    ): void;
    removeListener(
      event: 'exit',
      listener: (event: {
        terminalId?: string;
        terminal?: { id: string };
      }) => void,
    ): void;
    removeListener(event: 'disconnected', listener: () => void): void;
    removeListener(event: string, listener: (arg: never) => void): void;
  }
}

declare module '*/desktop/activity-snapshot.mjs' {
  export interface ActivityProject {
    project: string;
    branch?: string;
    lastActiveAt?: string;
  }

  export interface ActivitySnapshot {
    projects?: ActivityProject[];
    sessions?: unknown[];
    generatedAt?: string;
  }

  export function readValidatedActivitySnapshot(
    file: string,
  ): Promise<ActivitySnapshot | null>;
}
