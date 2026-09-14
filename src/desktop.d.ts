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
    daemonId: string | null;
    daemonPid: number | null;
    daemonBootId: string | null;
    connect(): Promise<void>;
    connectOrStart(): Promise<void>;
    disconnect(): void;
    start(
      options: Record<string, unknown>,
    ): Promise<{ id: string; status: string }>;
    stop(terminalId: string): Promise<unknown>;
    stopAll(): Promise<unknown>;
    attach(
      terminalId: string,
      cursor?: number,
    ): Promise<{
      data: string;
      startCursor: number;
      endCursor: number;
      nextCursor: number;
      terminal: { status: string; lifecycleState: string };
    }>;
    detach(terminalId: string): Promise<{ ok: boolean }>;
    acquireControl(
      terminalId: string,
      options?: { takeover?: boolean },
    ): Promise<{ ok: boolean; terminalId?: string }>;
    releaseControl(
      terminalId: string,
    ): Promise<{ ok: boolean; terminalId?: string }>;
    hasControl(terminalId: string): boolean;
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
        terminal?: { id: string; nextCursor?: number };
      }) => void,
    ): void;
    on(
      event: 'control_revoked',
      listener: (event: { terminalId: string; reason?: string }) => void,
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
        terminal?: { id: string; nextCursor?: number };
      }) => void,
    ): void;
    removeListener(
      event: 'control_revoked',
      listener: (event: { terminalId: string; reason?: string }) => void,
    ): void;
    removeListener(event: 'disconnected', listener: () => void): void;
    removeListener(event: string, listener: (arg: never) => void): void;
  }
}

declare module '*/desktop/terminal-daemon-protocol.mjs' {
  export const DAEMON_PROTOCOL_VERSION: number;
  export const DAEMON_MAX_FRAME_BYTES: number;
  export const DAEMON_MAX_IO_BYTES: number;
  export function encodeDaemonFrame(frame: Record<string, unknown>): string;
  export class DaemonFrameDecoder {
    constructor(maxBytes?: number);
    push(chunk: Buffer | Uint8Array | string): Array<Record<string, unknown>>;
  }
  export function validTerminalId(value: unknown): boolean;
  export function validStartRequest(value: unknown): boolean;
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

declare module '*/desktop/daemon-bridge-worker.mjs' {
  export const BRIDGE_WORKER_MAX_FRAME_BYTES: number;

  export class DaemonBridgeWorker {
    constructor(options: { nodePath: string; cliPath: string });
    updateProviderStatus(
      project: string,
      terminalId: string,
      observation: unknown,
    ): Promise<void>;
    registerBridge(
      project: string,
      terminalId: string,
      bridge: { instanceId: string; pid: number; protocolVersion: number },
    ): Promise<void>;
    stop(): void;
  }
}
