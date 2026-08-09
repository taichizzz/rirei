import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../src/config/schema.js';
import { writeConfig } from '../../src/config/loader.js';
import { relayPath } from '../../src/safety/path-policy.js';
import {
  ACTIVITY_SESSION_LIMIT,
  ACTIVITY_PROJECT_LIMIT,
  ACTIVITY_STRING_LIMIT,
  activityDataHome,
  activityFilePath,
  activitySnapshotSchema,
  appendEvent,
  mapLeaseStatus,
  readActivity,
  selectActivityUsage,
  stopActivityHeartbeat,
  syncActivity,
  type RireiActivitySnapshotV1,
} from '../../src/state/activity.js';
import type { RelayState, RunLease } from '../../src/state/schema.js';
import { readState, updateState, writeState } from '../../src/state/store.js';
import { writeRegistry } from '../../src/worktrees/registry.js';

const sandboxes: string[] = [];
const projectRoots: string[] = [];
const originalDataHome = process.env.RIREI_DATA_HOME;
const originalProviderUsageHome = process.env.RIREI_PROVIDER_USAGE_HOME;

async function waitForActivity(
  predicate: (snapshot: RireiActivitySnapshotV1 | undefined) => boolean,
  timeoutMs = 2_000,
): Promise<RireiActivitySnapshotV1> {
  const deadline = process.hrtime.bigint() + BigInt(timeoutMs) * 1_000_000n;
  while (process.hrtime.bigint() < deadline) {
    const snapshot = await readActivity();
    if (snapshot && predicate(snapshot)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for the activity heartbeat.');
}

async function sandbox(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'rirei-activity-'));
  sandboxes.push(root);
  process.env.RIREI_DATA_HOME = path.join(root, 'data');
  process.env.RIREI_PROVIDER_USAGE_HOME = path.join(root, 'provider-home');
  return root;
}

async function project(
  parent: string,
  name: string,
  overrides: Partial<RelayState> = {},
): Promise<{ root: string; state: RelayState }> {
  const root = path.join(parent, name);
  projectRoots.push(root);
  await mkdir(relayPath(root), { recursive: true });
  const now = new Date().toISOString();
  const state: RelayState = {
    schemaVersion: 3,
    revision: 0,
    recentOperations: [],
    runs: [],
    sessionId: `task-${name}`,
    projectRoot: root,
    task: {
      title: `Task ${name}`,
      originalRequest: 'This prompt must never be projected',
      requirements: [],
      constraints: [],
      status: 'active',
      createdAt: now,
      updatedAt: now,
    },
    git: {
      startingCommit: 'abc',
      startingBranch: 'main',
      dirtyAtStart: false,
    },
    agentHistory: [],
    decisions: [],
    completedWork: [],
    remainingWork: [],
    tests: [],
    checkpoints: [],
    blockers: [],
    ...overrides,
  };
  await writeConfig(root, defaultConfig);
  await writeState(root, state);
  return { root, state };
}

function lease(
  root: string,
  index: number,
  overrides: Partial<RunLease> = {},
): RunLease {
  const now = new Date().toISOString();
  return {
    runId: `run-${index}`,
    terminalId: `terminal-${index}`,
    workspaceId: `workspace-${index}`,
    branchLabel: `rirei/task-${index}`,
    role: 'implement',
    worktreePath: path.join(root, 'worktrees', String(index)),
    projectRoot: root,
    agent: 'codex',
    launchMode: 'new',
    controllerId: `terminal:${index}`,
    startedAt: now,
    lastSeenAt: now,
    status: 'running',
    ...overrides,
  };
}

afterEach(async () => {
  vi.useRealTimers();
  for (const root of projectRoots.splice(0)) stopActivityHeartbeat(root);
  if (originalDataHome === undefined) delete process.env.RIREI_DATA_HOME;
  else process.env.RIREI_DATA_HOME = originalDataHome;
  if (originalProviderUsageHome === undefined)
    delete process.env.RIREI_PROVIDER_USAGE_HOME;
  else process.env.RIREI_PROVIDER_USAGE_HOME = originalProviderUsageHome;
  await Promise.all(
    sandboxes
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('global activity snapshot', () => {
  it('resolves the macOS global path when no test override is set', () => {
    delete process.env.RIREI_DATA_HOME;
    if (process.platform === 'darwin')
      expect(activityFilePath()).toBe(
        path.join(
          process.env.HOME!,
          'Library',
          'Application Support',
          'Rirei',
          'activity.json',
        ),
      );
  });

  it('uses the hermetic data-home override and secure directory/file modes', async () => {
    const base = await sandbox();
    const { root, state } = await project(base, 'modes');
    state.runs = [lease(root, 1)];
    await syncActivity(root, state);

    expect(activityDataHome()).toBe(path.join(base, 'data'));
    expect(activityFilePath()).toBe(path.join(base, 'data', 'activity.json'));
    if (process.platform !== 'win32') {
      expect((await stat(activityDataHome())).mode & 0o777).toBe(0o700);
      expect((await stat(activityFilePath())).mode & 0o777).toBe(0o600);
    }
  });

  it('writes only the exact runtime-validated schema v1 session snapshot', async () => {
    const base = await sandbox();
    const { root, state } = await project(base, 'schema');
    state.runs = [lease(root, 1)];

    const snapshot = await syncActivity(root, state);
    expect(activitySnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(Object.keys(snapshot).sort()).toEqual([
      'instanceId',
      'schemaVersion',
      'sessions',
      'updatedAt',
    ]);
    expect(snapshot).not.toHaveProperty('events');
    expect(snapshot.sessions[0]).toEqual({
      id: 'terminal-1',
      runId: 'run-1',
      workspaceId: 'workspace-1',
      agent: 'codex',
      projectLabel: 'schema',
      taskLabel: 'Task schema',
      branchLabel: 'rirei/task-1',
      role: 'implement',
      status: 'working',
      message: 'Agent is working',
      startedAt: state.runs[0]!.startedAt,
      updatedAt: expect.any(String),
      needsAttention: false,
    });
  });

  it('publishes the most constrained fresh provider plan window', async () => {
    const base = await sandbox();
    const { root, state } = await project(base, 'usage');
    const now = Date.now();
    const usageDirectory = path.join(
      process.env.RIREI_PROVIDER_USAGE_HOME!,
      '.relay',
      'provider-usage',
    );
    await mkdir(usageDirectory, { recursive: true });
    await writeFile(
      path.join(usageDirectory, 'claude.json'),
      JSON.stringify({
        provider: 'claude',
        capturedAt: new Date(now).toISOString(),
        fiveHour: {
          usedPercentage: 80,
          resetsAt: Math.floor((now + 60 * 60 * 1000) / 1000),
        },
        week: {
          usedPercentage: 40,
          resetsAt: Math.floor((now + 24 * 60 * 60 * 1000) / 1000),
        },
      }),
    );
    state.runs = [lease(root, 1, { agent: 'claude' })];

    expect((await syncActivity(root, state)).sessions[0]?.usage).toEqual({
      window: 'five_hour',
      remainingPercentage: 20,
      resetsAt: expect.any(String),
      fresh: true,
    });
  });

  it('selects fresh usage before stale usage and uses a stable tie-break', () => {
    expect(
      selectActivityUsage({
        id: 'codex',
        displayName: 'Codex',
        status: 'available',
        statusReason: 'live_window',
        source: 'test',
        capturedAt: new Date().toISOString(),
        fiveHour: {
          usedPercentage: 50,
          remainingPercentage: 50,
          resetsAt: null,
          status: 'available',
          statusReason: 'live',
        },
        week: {
          usedPercentage: 95,
          remainingPercentage: 5,
          resetsAt: null,
          status: 'stale',
          statusReason: 'sample_stale',
        },
        detail: 'test',
      }),
    ).toMatchObject({
      window: 'five_hour',
      remainingPercentage: 50,
      fresh: true,
    });
  });

  it('rejects a future snapshot on write and replaces malformed v1 content safely', async () => {
    const base = await sandbox();
    const { root, state } = await project(base, 'recovery');
    state.runs = [lease(root, 1)];
    await mkdir(activityDataHome(), { recursive: true });
    await writeFile(
      activityFilePath(),
      JSON.stringify({ schemaVersion: 2, sessions: [] }),
    );
    await expect(syncActivity(root, state)).rejects.toThrow(/newer/);

    await writeFile(
      activityFilePath(),
      JSON.stringify({
        schemaVersion: 1,
        instanceId: 'malformed',
        updatedAt: new Date().toISOString(),
        sessions: [],
        events: [{ data: { prompt: 'LEAK-ME' } }],
      }),
    );
    await expect(readActivity()).resolves.toBeUndefined();
    const recovered = await syncActivity(root, state);
    expect(recovered.instanceId).not.toBe('malformed');
    expect(await readFile(activityFilePath(), 'utf8')).not.toContain('LEAK-ME');
  });

  it('uses generic project, task, and branch labels in privacy mode', async () => {
    const base = await sandbox();
    const { root, state } = await project(base, 'private-project');
    state.runs = [lease(root, 1)];
    await writeConfig(root, {
      ...defaultConfig,
      activity: { privacyMode: true },
    });

    const session = (await syncActivity(root, state)).sessions[0]!;
    expect(session).toMatchObject({
      projectLabel: 'Project',
      taskLabel: 'Task',
      branchLabel: 'Branch',
    });
  });

  it('bounds sessions and all public strings', async () => {
    const base = await sandbox();
    const { root, state } = await project(base, 'bounds');
    state.task.title = 'x'.repeat(ACTIVITY_STRING_LIMIT * 2);
    state.runs = Array.from(
      { length: ACTIVITY_SESSION_LIMIT + 20 },
      (_, index) =>
        lease(root, index, {
          terminalId: `terminal-${'x'.repeat(ACTIVITY_STRING_LIMIT * 2)}-${index}`,
        }),
    );

    const snapshot = await syncActivity(root, state);
    expect(snapshot.sessions).toHaveLength(ACTIVITY_SESSION_LIMIT);
    for (const session of snapshot.sessions) {
      for (const value of Object.values(session))
        if (typeof value === 'string')
          expect(value.length).toBeLessThanOrEqual(ACTIVITY_STRING_LIMIT);
    }
  });

  it('bounds the private cross-project source registry', async () => {
    const base = await sandbox();
    for (let index = 0; index < ACTIVITY_PROJECT_LIMIT + 3; index += 1) {
      const candidate = await project(base, `project-${index}`);
      await syncActivity(candidate.root, candidate.state);
    }
    const registry = JSON.parse(
      await readFile(
        path.join(activityDataHome(), 'activity-sources.json'),
        'utf8',
      ),
    ) as { sources: unknown[] };
    expect(registry.sources).toHaveLength(ACTIVITY_PROJECT_LIMIT);
    expect(JSON.stringify(registry)).not.toContain(base);
  });

  it('recovers a malformed source index without dropping valid projects', async () => {
    const base = await sandbox();
    const first = await project(base, 'recover-first');
    const second = await project(base, 'recover-second');
    first.state.runs = [lease(first.root, 1)];
    second.state.runs = [lease(second.root, 2)];
    await syncActivity(first.root, first.state);
    await syncActivity(second.root, second.state);
    await writeFile(
      path.join(activityDataHome(), 'activity-sources.json'),
      '{ malformed',
    );

    await syncActivity(first.root, first.state);

    expect(
      (await readActivity())?.sessions.map((session) => session.runId).sort(),
    ).toEqual(['run-1', 'run-2']);
  });

  it('serializes concurrent cross-project publication without losing either project', async () => {
    const base = await sandbox();
    const first = await project(base, 'first');
    const second = await project(base, 'second');
    first.state.runs = [lease(first.root, 1)];
    second.state.runs = [lease(second.root, 2)];
    await Promise.all([
      writeState(first.root, first.state),
      writeState(second.root, second.state),
    ]);

    await Promise.all([
      syncActivity(first.root, first.state),
      syncActivity(second.root, second.state),
    ]);
    expect(
      (await readActivity())?.sessions.map((item) => item.runId).sort(),
    ).toEqual(['run-1', 'run-2']);
  });

  it('never projects paths, provider IDs, event data, prompts, commands, or credentials', async () => {
    const base = await sandbox();
    const { root, state } = await project(base, 'sensitive');
    state.task.title =
      'api_key=TOP-SECRET at [/Volumes/Private/project] file:///Users/private/two sk-proj-1234567890 AKIAIOSFODNN7EXAMPLE';
    state.runs = [
      lease(root, 1, {
        providerSessionId: 'provider-session-secret',
        model: 'sensitive-model',
        worktreePath: '/Users/private/source',
      }),
    ];
    await writeState(root, state);
    await appendEvent(root, 'arbitrary', {
      prompt: 'PROMPT-SECRET',
      command: 'COMMAND-SECRET',
      response: 'RESPONSE-SECRET',
      terminalOutput: 'OUTPUT-SECRET',
      diff: 'DIFF-SECRET',
      token: 'TOKEN-SECRET',
      path: '/Users/private/source',
    });

    const json = await readFile(activityFilePath(), 'utf8');
    for (const secret of [
      root,
      '/Users/private/source',
      'provider-session-secret',
      'sensitive-model',
      'TOP-SECRET',
      '/Volumes/Private/project',
      'file:///Users/private/two',
      'sk-proj-1234567890',
      'AKIAIOSFODNN7EXAMPLE',
      'PROMPT-SECRET',
      'COMMAND-SECRET',
      'RESPONSE-SECRET',
      'OUTPUT-SECRET',
      'DIFF-SECRET',
      'TOKEN-SECRET',
      'This prompt must never be projected',
    ])
      expect(json).not.toContain(secret);
  });

  it('maps lease statuses into the plan vocabulary', () => {
    expect(mapLeaseStatus('starting')).toBe('starting');
    expect(mapLeaseStatus('running')).toBe('working');
    expect(mapLeaseStatus('waiting')).toBe('waiting');
    expect(mapLeaseStatus('stopping')).toBe('working');
    expect(mapLeaseStatus('orphaned')).toBe('orphaned');
  });

  it('excludes non-terminal runs that cannot support focus links', async () => {
    const base = await sandbox();
    const { root, state } = await project(base, 'cli-run');
    state.runs = [lease(root, 1, { terminalId: undefined })];
    expect((await syncActivity(root, state)).sessions).toEqual([]);
  });

  it('fails privacy closed when configuration cannot be parsed', async () => {
    const base = await sandbox();
    const { root, state } = await project(base, 'broken-config');
    state.runs = [lease(root, 1)];
    await writeFile(relayPath(root, 'config.json'), '{ broken');

    expect((await syncActivity(root, state)).sessions[0]).toMatchObject({
      projectLabel: 'Project',
      taskLabel: 'Task',
      branchLabel: 'Branch',
    });
  });

  it('heartbeats active runs and stops after the last publishable session', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-08-02T00:00:00.000Z'));
    const base = await sandbox();
    const { root, state } = await project(base, 'heartbeat');
    state.runs = [lease(root, 1)];
    await writeState(root, state);
    const initial = await syncActivity(root, state);

    await vi.advanceTimersByTimeAsync(5_000);
    const heartbeat = await waitForActivity(
      (snapshot) => snapshot.updatedAt !== initial.updatedAt,
    );
    expect(heartbeat.sessions[0]?.updatedAt).not.toBe(
      initial.sessions[0]?.updatedAt,
    );

    const inactive = { ...state, runs: [] };
    await writeState(root, inactive);
    await vi.advanceTimersByTimeAsync(5_000);
    const cleaned = await waitForActivity(
      (snapshot) => snapshot.sessions.length === 0,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await readActivity())?.updatedAt).toBe(cleaned.updatedAt);
  });

  it('retains only recent terminal-owned completed, cancelled, and failed runs', async () => {
    const base = await sandbox();
    const { root, state } = await project(base, 'completed');
    const now = Date.now();
    state.agentHistory = [
      {
        id: 'completed',
        terminalId: 'terminal-completed',
        agent: 'codex',
        startedAt: new Date(now - 2_000).toISOString(),
        endedAt: new Date(now - 1_000).toISOString(),
        exitReason: 'completed',
      },
      {
        id: 'cancelled',
        terminalId: 'terminal-cancelled',
        agent: 'claude',
        startedAt: new Date(now - 2_000).toISOString(),
        endedAt: new Date(now - 1_000).toISOString(),
        exitReason: 'user_cancelled',
      },
      {
        id: 'failed',
        terminalId: 'terminal-failed',
        agent: 'gemini',
        startedAt: new Date(now - 2_000).toISOString(),
        endedAt: new Date(now - 1_000).toISOString(),
        exitReason: 'network_error',
      },
      {
        id: 'not-terminal-owned',
        agent: 'codex',
        startedAt: new Date(now - 2_000).toISOString(),
        endedAt: new Date(now - 1_000).toISOString(),
        exitReason: 'completed',
      },
      {
        id: 'expired',
        terminalId: 'terminal-expired',
        agent: 'codex',
        startedAt: new Date(now - 60_000).toISOString(),
        endedAt: new Date(now - 31_000).toISOString(),
        exitReason: 'completed',
      },
    ];

    const sessions = (await syncActivity(root, state)).sessions;
    expect(
      Object.fromEntries(
        sessions.map((session) => [session.runId, session.status]),
      ),
    ).toEqual({
      failed: 'failed',
      completed: 'completed',
      cancelled: 'cancelled',
    });
    expect(
      sessions.find((session) => session.runId === 'failed')?.needsAttention,
    ).toBe(true);
  });

  it('uses canonical workspace branch and role metadata rather than the workspace UUID', async () => {
    const base = await sandbox();
    const { root, state } = await project(base, 'metadata');
    state.runs = [
      lease(root, 1, {
        workspaceId: 'workspace-uuid',
        branchLabel: 'workspace-uuid',
        role: 'implement',
      }),
    ];
    await writeRegistry(root, {
      schemaVersion: 1,
      workspaces: [
        {
          id: 'workspace-uuid',
          parentTaskId: state.sessionId,
          repositoryRoot: root,
          worktreePath: path.join(root, 'worktree'),
          branch: 'rirei/auth-review',
          baseCommit: 'abc',
          role: 'review',
          createdAt: new Date().toISOString(),
          status: 'active',
          terminalIds: ['terminal-1'],
        },
      ],
    });

    expect((await syncActivity(root, state)).sessions[0]).toMatchObject({
      id: 'terminal-1',
      workspaceId: 'workspace-uuid',
      branchLabel: 'rirei/auth-review',
      role: 'review',
    });
  });

  it('does not let activity publication failure break committed state', async () => {
    const base = await sandbox();
    const { root } = await project(base, 'best-effort');
    const invalidDataHome = path.join(base, 'not-a-directory');
    await writeFile(invalidDataHome, 'file');
    process.env.RIREI_DATA_HOME = invalidDataHome;

    const updated = await updateState(root, (current) => ({
      ...current,
      task: { ...current.task, title: 'Committed despite activity failure' },
    }));
    expect(updated.task.title).toBe('Committed despite activity failure');
    expect((await readState(root)).task.title).toBe(
      'Committed despite activity failure',
    );
  });

  it('retries a failed initial publication while an active run remains', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-08-02T00:00:00.000Z'));
    const base = await sandbox();
    const validDataHome = path.join(base, 'data');
    const { root } = await project(base, 'retry-publication');
    const invalidDataHome = path.join(base, 'not-a-directory');
    await writeFile(invalidDataHome, 'file');
    process.env.RIREI_DATA_HOME = invalidDataHome;

    await updateState(root, (current) => ({
      ...current,
      runs: [lease(root, 1)],
    }));
    process.env.RIREI_DATA_HOME = validDataHome;
    await vi.advanceTimersByTimeAsync(5_000);
    const retried = await waitForActivity(
      (snapshot) => snapshot.sessions[0]?.runId === 'run-1',
    );
    expect(retried.sessions[0]?.runId).toBe('run-1');
  });
});
