export interface TerminalDaemonClientLike {
  attach(
    terminalId: string,
    cursor?: number,
  ): Promise<{
    data: string;
    startCursor: number;
    endCursor: number;
    nextCursor?: number;
  }>;
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
  on(event: string, listener: (...args: never[]) => void): void;
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
  removeListener(event: string, listener: (...args: never[]) => void): void;
}

export interface AttachOptions {
  escapeKeyByte?: number;
  clearOnExit?: boolean;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  signalEmitter?: NodeJS.Process;
}

/**
 * Attach the user's terminal to a daemon session in raw passthrough mode.
 * Ctrl+] detaches and every completion path restores the caller's stream state.
 */
export async function attachTerminalSession(
  client: TerminalDaemonClientLike,
  terminalId: string,
  options: AttachOptions = {},
): Promise<void> {
  const escapeByte = options.escapeKeyByte ?? 0x1d;
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const signalEmitter = options.signalEmitter ?? process;
  const wasRaw = stdin.isRaw;
  const wasPaused = stdin.isPaused();
  let cursor = 0;
  let attached = false;
  let ending = false;
  let active = true;
  let pumping = false;
  let outputQueued = false;
  let targetCursor = 0;
  let cleanupPromise: Promise<void> | null = null;
  let resolveSession!: () => void;
  const sessionDone = new Promise<void>((resolve) => {
    resolveSession = resolve;
  });

  const finish = () => {
    if (ending) return;
    ending = true;
    resolveSession();
  };

  const onOutputAvailable = (event: {
    terminalId: string;
    nextCursor: number;
  }) => {
    if (!active || ending || event.terminalId !== terminalId) return;
    targetCursor = Math.max(targetCursor, event.nextCursor);
    outputQueued = true;
    pumpOutput();
  };
  const onExit = (event: {
    terminalId?: string;
    terminal?: { id: string };
  }) => {
    if ((event.terminalId ?? event.terminal?.id) === terminalId) finish();
  };
  const onDisconnected = () => finish();
  const onSignal = () => finish();
  const onResize = () => {
    if (!active || ending) return;
    const cols = stdout.columns || 80;
    const rows = Math.max(1, (stdout.rows || 24) - 2);
    void client.resize(terminalId, { cols, rows }).catch(finish);
  };
  const onData = (chunk: Buffer) => {
    if (chunk.length === 1 && chunk[0] === escapeByte) {
      finish();
      return;
    }
    void client.write(terminalId, chunk).catch(finish);
  };

  function pumpOutput() {
    if (pumping || ending || !active) return;
    pumping = true;
    void (async () => {
      while (outputQueued && active && !ending) {
        outputQueued = false;
        const slice = await client.attach(terminalId, cursor);
        if (!active || ending) return;
        if (slice.data) stdout.write(Buffer.from(slice.data, 'base64'));
        cursor = slice.endCursor;
        if (cursor < targetCursor) outputQueued = true;
      }
    })()
      .catch(finish)
      .finally(() => {
        pumping = false;
        if (outputQueued && active && !ending) pumpOutput();
      });
  }

  const cleanup = () => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      active = false;
      stdin.removeListener('data', onData);
      stdout.removeListener('resize', onResize);
      signalEmitter.removeListener('SIGINT', onSignal);
      signalEmitter.removeListener('SIGTERM', onSignal);
      client.removeListener('output_available', onOutputAvailable);
      client.removeListener('exit', onExit);
      client.removeListener('disconnected', onDisconnected);
      if (stdin.setRawMode) stdin.setRawMode(wasRaw ?? false);
      if (wasPaused) stdin.pause();
      else stdin.resume();
      if (attached) await client.detach(terminalId).catch(() => undefined);
      if (options.clearOnExit !== false) stdout.write('\x1b[2J\x1b[H');
    })();
    return cleanupPromise;
  };

  stdout.write('\x1b[2J\x1b[H');
  stdout.write(
    '\x1b[36m[Relay: Attached to session. Press Ctrl+] to detach back to dashboard]\x1b[0m\r\n\r\n',
  );

  try {
    await client.resize(terminalId, {
      cols: stdout.columns || 80,
      rows: Math.max(1, (stdout.rows || 24) - 2),
    });
    const replay = await client.attach(terminalId, cursor);
    attached = true;
    if (replay.data) stdout.write(Buffer.from(replay.data, 'base64'));
    cursor = replay.endCursor;
    targetCursor = replay.nextCursor ?? cursor;

    client.on('output_available', onOutputAvailable);
    client.on('exit', onExit);
    client.on('disconnected', onDisconnected);
    stdout.on('resize', onResize);
    signalEmitter.on('SIGINT', onSignal);
    signalEmitter.on('SIGTERM', onSignal);
    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();
    if (cursor < targetCursor) {
      outputQueued = true;
      pumpOutput();
    }

    stdin.on('data', onData);
    await sessionDone;
  } catch {
    finish();
  } finally {
    await cleanup();
  }
}
