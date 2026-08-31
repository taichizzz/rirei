import { PassThrough } from 'node:stream';
import type { AgentCatalogEntry } from '../../src/agents/registry.js';
import { createApp } from '../../src/tui/app.js';
import type { DashboardData } from '../../src/tui/state.js';
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
};

function renderDashboard() {
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
  stdout.columns = 80;
  stdout.rows = 24;
  stdout.isTTY = false;
  const frames: string[] = [];
  stdout.on('data', (chunk) => frames.push(stripAnsi(chunk.toString())));

  const onLaunchAgent = vi.fn(async () => undefined);
  const App = createApp(ink, React);
  const instance = ink.render(
    React.createElement(App, {
      initialData: dashboard,
      agentCatalog: catalog,
      terminals: [],
      daemonConnected: true,
      onLaunchAgent,
      onLaunchShell: async () => undefined,
      onAttach: () => undefined,
      onRefresh: async () => undefined,
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

  return { frameContaining, latestFrame, onLaunchAgent, send };
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
});
