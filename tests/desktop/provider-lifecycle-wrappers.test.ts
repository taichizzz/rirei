import { describe, expect, it, vi } from 'vitest';
import {
  CODEX_REMOTE_TOKEN_ENV,
  codexAppServerArgs,
  codexLifecycleState,
  codexRemoteArgs,
} from '../../desktop/codex-lifecycle-wrapper.mjs';
import {
  consumeEvents,
  endpointJson,
  OpenCodeLifecycleTracker,
  openCodeNetworkArgs,
  readBoundedJson,
} from '../../desktop/opencode-lifecycle-wrapper.mjs';

describe('provider lifecycle wrappers', () => {
  it('preserves Codex run and resume arguments around remote mode', () => {
    expect(
      codexRemoteArgs(['--model', 'gpt-5', 'Prompt'], 'ws://host'),
    ).toEqual([
      '--remote',
      'ws://host',
      '--remote-auth-token-env',
      CODEX_REMOTE_TOKEN_ENV,
      '--model',
      'gpt-5',
      'Prompt',
    ]);
    expect(
      codexRemoteArgs(['resume', '--last', 'Prompt'], 'ws://host'),
    ).toEqual([
      'resume',
      '--remote',
      'ws://host',
      '--remote-auth-token-env',
      CODEX_REMOTE_TOKEN_ENV,
      '--last',
      'Prompt',
    ]);
  });

  it('authenticates the Codex app server without exposing the raw token', () => {
    const token = 'launch-secret';
    const args = codexAppServerArgs(token);
    expect(args).toEqual([
      'app-server',
      '--listen',
      'ws://127.0.0.1:0',
      '--ws-auth',
      'capability-token',
      '--ws-token-sha256',
      '64922df544abf1200189d5d7cb69c4b5c4e68336ed203518504f2fe5b5457e20',
    ]);
    expect(args).not.toContain(token);
  });

  it('maps only authoritative Codex thread status notifications', () => {
    expect(
      codexLifecycleState({
        method: 'thread/status/changed',
        params: {
          status: { type: 'active', activeFlags: ['waitingOnApproval'] },
        },
      }),
    ).toBe('needs_permission');
    expect(
      codexLifecycleState({
        method: 'thread/status/changed',
        params: {
          status: { type: 'active', activeFlags: ['waitingOnUserInput'] },
        },
      }),
    ).toBe('waiting_for_input');
    expect(
      codexLifecycleState({
        method: 'thread/status/changed',
        params: { status: { type: 'active', activeFlags: [] } },
      }),
    ).toBe('working');
    expect(
      codexLifecycleState({
        method: 'thread/status/changed',
        params: { status: { type: 'idle' } },
      }),
    ).toBe('waiting_for_input');
    expect(codexLifecycleState({ method: 'turn/started' })).toBeNull();
  });

  it('preserves OpenCode TUI arguments and rejects conflicting servers', () => {
    expect(
      openCodeNetworkArgs(['--model', 'openai/gpt-5', '--prompt', 'Do it']),
    ).toEqual([
      '--hostname',
      '127.0.0.1',
      '--port',
      '0',
      '--model',
      'openai/gpt-5',
      '--prompt',
      'Do it',
    ]);
    expect(() => openCodeNetworkArgs(['--mini'])).toThrow(/conflicting/);
    expect(() => openCodeNetworkArgs(['--port=4096'])).toThrow(/conflicting/);
  });

  it('prioritizes OpenCode permissions, questions, and active sessions', () => {
    const states: string[] = [];
    const tracker = new OpenCodeLifecycleTracker((state: string) =>
      states.push(state),
    );
    tracker.replace([], [], { root: { type: 'busy' } });
    tracker.apply({
      type: 'permission.asked',
      properties: { id: 'permission-1' },
    });
    tracker.apply({
      type: 'question.asked',
      properties: { id: 'question-1' },
    });
    tracker.apply({
      type: 'permission.replied',
      properties: { requestID: 'permission-1' },
    });
    tracker.apply({
      type: 'question.replied',
      properties: { requestID: 'question-1' },
    });
    tracker.apply({
      type: 'session.idle',
      properties: { sessionID: 'root' },
    });
    expect(states).toEqual([
      'working',
      'needs_permission',
      'waiting_for_input',
      'working',
      'waiting_for_input',
    ]);
  });

  it('cancels an OpenCode REST response as soon as its byte cap is exceeded', async () => {
    let chunks = 0;
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          chunks += 1;
          controller.enqueue(new Uint8Array(64 * 1024));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );

    await expect(readBoundedJson(response)).rejects.toThrow(/too large/);
    expect(chunks).toBeLessThanOrEqual(17);
    expect(cancelled).toBe(true);
  });

  it('bounds cumulative OpenCode SSE data and idle reads', async () => {
    let cancelled = false;
    const oversized = new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(
            new TextEncoder().encode(`data: ${'x'.repeat(2048)}\n`),
          );
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
    const tracker = { apply: vi.fn() };
    await expect(
      consumeEvents(oversized, tracker, new AbortController().signal, 1_000),
    ).rejects.toThrow(/too large/);
    expect(cancelled).toBe(true);
    expect(tracker.apply).not.toHaveBeenCalled();

    let idleCancelled = false;
    const idle = new Response(
      new ReadableStream({
        cancel() {
          idleCancelled = true;
        },
      }),
    );
    await expect(
      consumeEvents(idle, tracker, new AbortController().signal, 10),
    ).rejects.toThrow(/became idle/);
    expect(idleCancelled).toBe(true);
  });

  it('applies OpenCode deadlines before headers and while reading REST bodies', async () => {
    const signal = new AbortController().signal;
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          (_url, options) =>
            new Promise((_resolve, reject) => {
              options.signal.addEventListener(
                'abort',
                () => reject(options.signal.reason),
                { once: true },
              );
            }),
        ),
      );
      await expect(
        endpointJson('http://127.0.0.1/', '/held', {}, signal, 10),
      ).rejects.toThrow(/timed out/);

      vi.stubGlobal(
        'fetch',
        vi.fn((_url, options) =>
          Promise.resolve(
            new Response(
              new ReadableStream({
                start(controller) {
                  options.signal.addEventListener(
                    'abort',
                    () => controller.error(options.signal.reason),
                    { once: true },
                  );
                },
              }),
            ),
          ),
        ),
      );
      await expect(
        endpointJson('http://127.0.0.1/', '/held-body', {}, signal, 10),
      ).rejects.toThrow(/timed out/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
