export interface TerminalDaemonClientLike {
  attach(
    terminalId: string,
    cursor?: number,
  ): Promise<{
    data: string;
    startCursor: number;
    endCursor: number;
    nextCursor?: number;
    terminal?: { status?: string; lifecycleState?: string };
  }>;
  detach(terminalId: string): Promise<{ ok: boolean }>;
  acquireControl?(
    terminalId: string,
    options?: { takeover?: boolean },
  ): Promise<{ ok: boolean; terminalId?: string }>;
  releaseControl?(
    terminalId: string,
  ): Promise<{ ok: boolean; terminalId?: string }>;
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
      terminal?: { id: string; nextCursor?: number };
    }) => void,
  ): void;
  on(
    event: 'control_revoked',
    listener: (event: { terminalId: string; reason?: string }) => void,
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
      terminal?: { id: string; nextCursor?: number };
    }) => void,
  ): void;
  removeListener(
    event: 'control_revoked',
    listener: (event: { terminalId: string; reason?: string }) => void,
  ): void;
  removeListener(event: 'disconnected', listener: () => void): void;
  removeListener(event: string, listener: (...args: never[]) => void): void;
}

export interface AttachOptions {
  escapeKeyByte?: number;
  detachPrefixByte?: number;
  detachCommandByte?: number;
  clearOnExit?: boolean;
  returnToDashboard?: boolean;
  readOnly?: boolean;
  takeover?: boolean;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  signalEmitter?: NodeJS.Process;
}

const FINAL_TERMINAL_STATUSES = new Set([
  'finished',
  'completed',
  'failed',
  'cancelled',
  'orphaned',
]);

/**
 * Attach the user's terminal to a daemon session in raw passthrough mode.
 * Ctrl+Q detaches. Ctrl+B then D and Ctrl+] remain fallbacks.
 * Every completion path restores the caller's stream state.
 */
export async function attachTerminalSession(
  client: TerminalDaemonClientLike,
  terminalId: string,
  options: AttachOptions = {},
): Promise<void> {
  const escapeByte = options.escapeKeyByte ?? 0x1d;
  const dashboardByte = 0x11;
  const detachPrefixByte = options.detachPrefixByte ?? 0x02;
  const detachCommandByte = options.detachCommandByte ?? 0x64;
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const signalEmitter = options.signalEmitter ?? process;
  const wasRaw = stdin.isRaw;
  const wasPaused = stdin.isPaused();
  let cursor = 0;
  let attachRequested = false;
  let controlAcquired = false;
  let ending = false;
  let active = true;
  let replayReady = false;
  let exitPending = false;
  let pumping = false;
  let outputQueued = false;
  let targetCursor = 0;
  let detachPrefixPending = false;
  let rawModeChanged = false;
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
    if (replayReady) pumpOutput();
  };
  const onExit = (event: {
    terminalId?: string;
    terminal?: { id: string; nextCursor?: number };
  }) => {
    if ((event.terminalId ?? event.terminal?.id) !== terminalId) return;
    exitPending = true;
    if (Number.isSafeInteger(event.terminal?.nextCursor)) {
      targetCursor = Math.max(targetCursor, event.terminal!.nextCursor!);
    }
    if (!replayReady) return;
    if (cursor < targetCursor) {
      outputQueued = true;
      pumpOutput();
    } else {
      finish();
    }
  };
  const onControlRevoked = (event: { terminalId: string; reason?: string }) => {
    if (event.terminalId !== terminalId) return;
    controlAcquired = false;
    stdout.write(
      '\r\n\x1b[33m[Relay: Terminal control was taken over by another client.]\x1b[0m\r\n',
    );
    finish();
  };
  const onDisconnected = () => finish();
  const onSignal = () => finish();
  const onResize = () => {
    if (!active || ending || !controlAcquired) return;
    const cols = stdout.columns || 80;
    const rows = Math.max(1, (stdout.rows || 24) - 2);
    void client.resize(terminalId, { cols, rows }).catch(finish);
  };
  const onData = (chunk: Buffer | string) => {
    const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    const forwarded: number[] = [];
    for (const byte of input) {
      if (byte === dashboardByte || byte === escapeByte) {
        if (!options.readOnly && forwarded.length > 0)
          void client.write(terminalId, Buffer.from(forwarded)).catch(finish);
        finish();
        return;
      }
      if (detachPrefixPending) {
        detachPrefixPending = false;
        if (byte === detachCommandByte || byte === 0x44) {
          if (!options.readOnly && forwarded.length > 0)
            void client.write(terminalId, Buffer.from(forwarded)).catch(finish);
          finish();
          return;
        }
        forwarded.push(detachPrefixByte);
      }
      if (byte === detachPrefixByte) detachPrefixPending = true;
      else forwarded.push(byte);
    }
    if (!options.readOnly && forwarded.length > 0)
      void client.write(terminalId, Buffer.from(forwarded)).catch(finish);
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
        targetCursor = Math.max(
          targetCursor,
          Number.isSafeInteger(slice.nextCursor)
            ? slice.nextCursor!
            : slice.endCursor,
        );
        if (slice.endCursor <= cursor && cursor < targetCursor) {
          throw new Error('Terminal output cursor did not advance.');
        }
        cursor = slice.endCursor;
        if (cursor < targetCursor) outputQueued = true;
        else if (exitPending) finish();
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
      client.removeListener('control_revoked', onControlRevoked);
      client.removeListener('disconnected', onDisconnected);
      if (rawModeChanged && stdin.setRawMode) stdin.setRawMode(wasRaw ?? false);
      if (wasPaused) stdin.pause();
      else stdin.resume();
      if (controlAcquired && client.releaseControl) {
        await client.releaseControl(terminalId).catch(() => undefined);
        controlAcquired = false;
      }
      if (attachRequested) {
        await client.detach(terminalId).catch(() => undefined);
      }
      stdout.write(
        options.returnToDashboard === false
          ? '\x1b]0;Relay\x07'
          : '\x1b]0;Relay TUI\x07',
      );
      if (options.clearOnExit !== false) stdout.write('\x1b[2J\x1b[H');
    })();
    return cleanupPromise;
  };

  stdout.write('\x1b[2J\x1b[H');
  const detachLabel =
    options.returnToDashboard === false ? 'detach' : 'return to dashboard';
  stdout.write(
    `\x1b[36m[Relay: Attached. Press Ctrl+Q to ${detachLabel}. Ctrl+B then D also works.]\x1b[0m\r\n\r\n`,
  );

  try {
    client.on('output_available', onOutputAvailable);
    client.on('exit', onExit);
    client.on('control_revoked', onControlRevoked);
    client.on('disconnected', onDisconnected);

    attachRequested = true;
    const replay = await client.attach(terminalId, cursor);
    const alreadyFinal =
      FINAL_TERMINAL_STATUSES.has(replay.terminal?.status ?? '') ||
      FINAL_TERMINAL_STATUSES.has(replay.terminal?.lifecycleState ?? '');

    if (!options.readOnly && !alreadyFinal) {
      try {
        if (client.acquireControl) {
          await client.acquireControl(terminalId, {
            takeover: options.takeover,
          });
        }
        controlAcquired = true;
        await client.resize(terminalId, {
          cols: stdout.columns || 80,
          rows: Math.max(1, (stdout.rows || 24) - 2),
        });
        stdout.on('resize', onResize);
      } catch (error) {
        const code =
          typeof error === 'object' && error !== null
            ? ((error as { code?: string; daemonCode?: string }).daemonCode ??
              (error as { code?: string }).code)
            : undefined;
        if (code !== 'not_running') throw error;
        exitPending = true;
        outputQueued = true;
      }
    }

    if (replay.data) stdout.write(Buffer.from(replay.data, 'base64'));
    stdout.write(
      options.returnToDashboard === false
        ? '\x1b]0;Relay session - Ctrl+Q detaches\x07'
        : '\x1b]0;Relay session - Ctrl+Q returns to dashboard\x07',
    );
    cursor = replay.endCursor;
    targetCursor = Math.max(targetCursor, replay.nextCursor ?? cursor);
    if (alreadyFinal) exitPending = true;
    replayReady = true;

    if (!exitPending) {
      signalEmitter.on('SIGINT', onSignal);
      signalEmitter.on('SIGTERM', onSignal);
      if (stdin.setRawMode) {
        stdin.setRawMode(true);
        rawModeChanged = true;
      }
      stdin.resume();
      stdin.on('data', onData);
    }
    if (cursor < targetCursor || outputQueued) {
      outputQueued = true;
      pumpOutput();
    } else if (exitPending) {
      finish();
    }

    await sessionDone;
  } catch (error) {
    finish();
    throw error;
  } finally {
    await cleanup();
  }
}
