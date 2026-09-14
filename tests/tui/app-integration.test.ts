import { PassThrough } from 'node:stream';
import type { AgentCatalogEntry } from '../../src/agents/registry.js';
import { createApp } from '../../src/tui/app.js';
import type { DashboardData } from '../../src/tui/state.js';
import { buildThreadsData } from '../../src/tui/threads.js';
import type { ThreadsJournal } from '../../src/messages/schema.js';
import * as ink from 'ink';
import React from 'react';
import stripAnsi from 'strip-ansi';
import { afterEach, describe, expect, test, vi } from 'vitest';

const mounted: Array<{ unmount(): void }> = [];

afterEach(() => {
  for (const instance of mounted.splice(0)) instance.unmount();
});

const catalog = [
  {
    id: 'claude',
    displayName: 'Claude',
    installed: true,
    version: 'test',
    capabilities: {},
    models: {
      status: 'available',
      source: 'test catalog',
      values: [
        { id: 'fast', label: 'Fast', efforts: ['low', 'medium'] },
        { id: 'deep', label: 'Deep', efforts: ['high'] },
      ],
    },
    efforts: ['low', 'medium', 'high'],
  },
] as unknown as AgentCatalogEntry[];

const dashboard: DashboardData = {
  activity: null,
  currentProject: '/work/rirei',
  lastUpdated: '12:00:00',
  planUsage: {
    claude: {
      id: 'claude',
      displayName: 'Claude',
      status: 'available',
      statusReason: 'live_window',
      source: 'Claude Code local usage',
      capturedAt: '2026-08-30T12:00:00.000Z',
      metrics: [],
      detail: 'Verified local quota windows.',
      fiveHour: {
        usedPercentage: 32,
        remainingPercentage: 68,
        resetsAt: '2026-08-30T13:00:00.000Z',
        status: 'stale',
        statusReason: 'sample_stale',
      },
      week: {
        usedPercentage: 54,
        remainingPercentage: 46,
        resetsAt: '2026-09-06T12:00:00.000Z',
        status: 'available',
        statusReason: 'live',
      },
    },
    codex: {
      id: 'codex',
      displayName: 'Codex',
      status: 'error',
      statusReason: 'collector_error',
      source: 'Codex usage reader',
      capturedAt: null,
      metrics: [],
      detail: 'Provider usage could not be read safely.',
    },
  },
  threads: {
    status: 'ready',
    writable: true,
    projectRoot: '/work/rirei',
    sessionId: 'session-1',
    actor: { kind: 'operator' },
    actorRef: 'operator',
    peers: [],
    summaries: [],
    messages: [],
    unreadCount: 0,
    revision: 0,
  },
};

function dashboardWithThreads(): DashboardData {
  const firstThread = '11111111-1111-4111-8111-111111111111';
  const journal: ThreadsJournal = {
    schemaVersion: 1,
    sessionId: 'session-1',
    revision: 3,
    nextSequence: 4,
    recentOperations: [],
    messages: [
      {
        id: firstThread,
        sequence: 1,
        threadId: firstThread,
        from: { kind: 'operator' },
        to: { kind: 'run', runId: 'worker-1' },
        intent: 'request',
        body: 'Please verify the terminal workflow.',
        contextCards: [],
        deliveryMode: 'inbox',
        createdAt: '2026-08-30T12:00:00.000Z',
        delivery: {
          state: 'delivered',
          attemptCount: 1,
          deliveredAt: '2026-08-30T12:00:01.000Z',
        },
        redactions: [],
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        sequence: 2,
        threadId: firstThread,
        replyToId: firstThread,
        from: { kind: 'run', runId: 'worker-1' },
        to: { kind: 'operator' },
        intent: 'inform',
        body: 'Verification completed without errors.',
        contextCards: [],
        deliveryMode: 'inbox',
        createdAt: '2026-08-30T12:01:00.000Z',
        delivery: {
          state: 'delivered',
          attemptCount: 1,
          deliveredAt: '2026-08-30T12:01:01.000Z',
        },
        redactions: [],
      },
      {
        id: '33333333-3333-4333-8333-333333333333',
        sequence: 3,
        threadId: '33333333-3333-4333-8333-333333333333',
        from: { kind: 'operator' },
        to: { kind: 'run', runId: 'worker-1' },
        intent: 'inform',
        body: 'Alpha follow-up is queued.',
        contextCards: [],
        deliveryMode: 'inbox',
        createdAt: '2026-08-30T12:02:00.000Z',
        delivery: { state: 'queued', attemptCount: 0 },
        redactions: [],
      },
    ],
  };
  return {
    ...dashboard,
    threads: buildThreadsData({
      journal,
      actor: { kind: 'operator' },
      peerRuns: [{ runId: 'worker-1', agent: 'claude' }],
      projectRoot: '/work/rirei',
    }),
  };
}

function renderDashboard(
  data: DashboardData = dashboard,
  columns = 80,
  rows = 24,
  terminals: Array<{
    id: string;
    provider: string;
    project: string;
    workspaceId: string;
    branchLabel: string;
    status: string;
  }> = [],
) {
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean;
    isRaw: boolean;
    setRawMode(value: boolean): typeof stdin;
    ref(): typeof stdin;
    unref(): typeof stdin;
  };
  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.setRawMode = (value) => {
    stdin.isRaw = value;
    return stdin;
  };
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;

  const stdout = new PassThrough() as PassThrough & {
    columns: number;
    rows: number;
    isTTY: boolean;
  };
  stdout.columns = columns;
  stdout.rows = rows;
  stdout.isTTY = false;
  const frames: string[] = [];
  stdout.on('data', (chunk) => frames.push(stripAnsi(chunk.toString())));

  const onLaunchAgent = vi.fn(async () => undefined);
  const onStop = vi.fn(async () => undefined);
  const onStopAll = vi.fn(async () => undefined);
  const onSendMessage = vi.fn(async () => data.threads);
  const onReplyMessage = vi.fn(async () => data.threads);
  const onMarkMessageRead = vi.fn(async () => data.threads);
  const onAcknowledgeMessage = vi.fn(async () => data.threads);
  const App = createApp(ink, React);
  const instance = ink.render(
    React.createElement(App, {
      initialData: data,
      agentCatalog: catalog,
      terminals,
      daemonConnected: true,
      onLaunchAgent,
      onLaunchShell: async () => undefined,
      onAttach: () => undefined,
      onStop,
      onStopAll,
      onRefresh: async () => undefined,
      onRefreshThreads: async () => data.threads,
      onSendMessage,
      onReplyMessage,
      onMarkMessageRead,
      onAcknowledgeMessage,
      onQuit: () => undefined,
    }),
    {
      debug: true,
      exitOnCtrlC: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    },
  );
  mounted.push(instance);

  const send = async (input: string) => {
    stdin.write(input);
    // Ink refreshes its input callback after each render. A human cannot send
    // the next key during that gap, so keep the synthetic stream realistic.
    await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
  };
  const frameContaining = (marker: string) =>
    frames.findLast((frame) => frame.includes(marker)) ?? '';
  const latestFrame = () => frames.at(-1) ?? '';

  return {
    frameContaining,
    latestFrame,
    onAcknowledgeMessage,
    onLaunchAgent,
    onMarkMessageRead,
    onReplyMessage,
    onSendMessage,
    onStop,
    onStopAll,
    send,
  };
}

describe('TUI rendered interactions', () => {
  test('selects a discovered model and model-specific effort for launch', async () => {
    const app = renderDashboard();

    await app.send('c');
    await vi.waitFor(() => expect(app.latestFrame()).toContain('CONFIGURE'));
    await app.send('\r');
    await vi.waitFor(() => expect(app.latestFrame()).toContain('‹ Fast ›'));
    await app.send('\t');
    await vi.waitFor(() => expect(app.latestFrame()).toContain('> EFFORT'));
    await app.send('\r');
    await vi.waitFor(() => expect(app.latestFrame()).toContain('‹ low ›'));
    await app.send('l');

    await vi.waitFor(() =>
      expect(app.onLaunchAgent).toHaveBeenCalledWith({
        agent: 'claude',
        model: 'fast',
        effort: 'low',
      }),
    );
  });

  test('accepts a custom model ID without leaking the selector sentinel', async () => {
    const app = renderDashboard();

    await app.send('c');
    await vi.waitFor(() => expect(app.latestFrame()).toContain('CONFIGURE'));
    await app.send('\r');
    await vi.waitFor(() => expect(app.latestFrame()).toContain('‹ Fast ›'));
    await app.send('\r');
    await vi.waitFor(() => expect(app.latestFrame()).toContain('‹ Deep ›'));
    await app.send('\r');
    await vi.waitFor(() =>
      expect(app.latestFrame()).toContain('Custom: type model ID'),
    );
    await app.send('vendor/model-x');
    await vi.waitFor(() =>
      expect(app.latestFrame()).toContain('Custom: vendor/model-x'),
    );
    await app.send('\u007F');
    await app.send('2');
    await vi.waitFor(() =>
      expect(app.latestFrame()).toContain('Custom: vendor/model-2'),
    );
    await app.send('\r');
    await vi.waitFor(() => expect(app.latestFrame()).toContain('> EFFORT'));
    await app.send('\r');
    await vi.waitFor(() => expect(app.latestFrame()).toContain('‹ low ›'));
    await app.send('l');

    await vi.waitFor(() =>
      expect(app.onLaunchAgent).toHaveBeenCalledWith({
        agent: 'claude',
        model: 'vendor/model-2',
        effort: 'low',
      }),
    );
  });

  test('renders remaining, stale, and collector-error states at 80x24', async () => {
    const app = renderDashboard();

    await app.send('u');

    await vi.waitFor(() => {
      const frame = app.frameContaining('PLAN REMAINING');
      expect(frame).toContain('68% STALE');
      expect(frame).toContain('46%');
      expect(frame).toContain('CODEX / Codex usage reader');
      expect(frame).toContain('READ ERROR');
      expect(frame).toContain('UPDATED 2026-08-30T12:00:00Z');
      expect(frame).toContain('5H 2026-08-30T13:00:00Z');
      expect(frame.split('\n')).toHaveLength(24);
      expect(
        Math.max(...frame.split('\n').map((line) => [...line].length)),
      ).toBeLessThanOrEqual(80);
    });
  });

  test('shows inbox attention, filters threads, and renders detail receipts', async () => {
    const app = renderDashboard(dashboardWithThreads());

    await vi.waitFor(() =>
      expect(app.latestFrame()).toContain('1 UNREAD / M INBOX'),
    );
    await app.send('m');
    await vi.waitFor(() => {
      expect(app.latestFrame()).toContain('RELAY THREADS');
      expect(app.latestFrame()).toContain('operator <-> run:worker-1');
    });
    await app.send('/');
    await app.send('completed');
    await app.send('\r');
    await vi.waitFor(() => {
      expect(app.latestFrame()).toContain('Verification completed');
      expect(app.latestFrame()).not.toContain('Alpha follow-up');
    });
    await app.send('\r');
    await vi.waitFor(() => {
      expect(app.latestFrame()).toContain(
        'Verification completed without errors.',
      );
      expect(app.latestFrame()).toContain(
        'RECEIPT DELIVERED 2026-08-30T12:01:01.000Z',
      );
    });
    await app.send('m');
    await vi.waitFor(() =>
      expect(app.onMarkMessageRead).toHaveBeenCalledWith(
        '22222222-2222-4222-8222-222222222222',
      ),
    );
    await app.send('a');
    await vi.waitFor(() =>
      expect(app.onAcknowledgeMessage).toHaveBeenCalledWith(
        '22222222-2222-4222-8222-222222222222',
      ),
    );
  });

  test('composes inbox-only messages and replies with canonical refs', async () => {
    const app = renderDashboard(dashboardWithThreads());

    await app.send('m');
    await app.send('n');
    await vi.waitFor(() => {
      const frame = app.latestFrame();
      expect(frame).toContain('NEW MESSAGE');
      expect(frame).toContain('run:worker-1');
      expect(frame).toContain('INBOX ONLY');
      expect(frame).not.toContain('next_safe_turn');
      expect(frame).not.toContain('wake');
    });
    await app.send('\t');
    await app.send('\t');
    await app.send('Please inspect the latest changes.');
    await app.send('\r');
    await vi.waitFor(() =>
      expect(app.onSendMessage).toHaveBeenCalledWith({
        to: 'run:worker-1',
        intent: 'request',
        body: 'Please inspect the latest changes.',
        deliveryMode: 'inbox',
      }),
    );

    await app.send('\r');
    await app.send('r');
    await app.send('\t');
    await app.send('Reply from the operator.');
    await app.send('\r');
    await vi.waitFor(() =>
      expect(app.onReplyMessage).toHaveBeenCalledWith({
        parentMessageId: '33333333-3333-4333-8333-333333333333',
        intent: 'inform',
        body: 'Reply from the operator.',
        deliveryMode: 'inbox',
      }),
    );
  });

  test('keeps the thread list bounded in a narrow terminal', async () => {
    const app = renderDashboard(dashboardWithThreads(), 52, 16);
    await app.send('m');

    await vi.waitFor(() => {
      const frame = app.latestFrame();
      expect(frame.split('\n')).toHaveLength(16);
      expect(
        Math.max(...frame.split('\n').map((line) => [...line].length)),
      ).toBeLessThanOrEqual(52);
    });
  });

  test('confirms selected and all-session stop actions', async () => {
    const terminals = [
      {
        id: 'terminal-1',
        provider: 'codex',
        project: '/work/rirei',
        workspaceId: 'main',
        branchLabel: 'main',
        status: 'running',
      },
      {
        id: 'terminal-2',
        provider: 'claude',
        project: '/work/rirei',
        workspaceId: 'workspace-2',
        branchLabel: 'feature/two',
        status: 'waiting',
      },
    ];
    const app = renderDashboard(dashboard, 80, 24, terminals);

    await app.send('x');
    await vi.waitFor(() =>
      expect(app.latestFrame()).toContain('STOP SESSION?'),
    );
    await app.send('y');
    await vi.waitFor(() =>
      expect(app.onStop).toHaveBeenCalledWith('terminal-1'),
    );

    await app.send('X');
    await vi.waitFor(() =>
      expect(app.latestFrame()).toContain('STOP ALL SESSIONS?'),
    );
    expect(app.latestFrame()).toContain('Stop 2 active sessions');
    await app.send('\r');
    await vi.waitFor(() => expect(app.onStopAll).toHaveBeenCalledOnce());
  });
});
