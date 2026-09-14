import { describe, expect, it } from 'vitest';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  capabilityDescriptorPath,
  issueMessageCapability,
  resolveCurrentActor,
  revokeMessageCapability,
} from '../../src/messages/capability.js';
import {
  LATEST_STATE_SCHEMA,
  type RelayState,
} from '../../src/state/schema.js';
import { createRepository, removeRepository } from '../helpers.js';
import { relayPath } from '../../src/safety/path-policy.js';

function testState(root: string): RelayState {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    schemaVersion: LATEST_STATE_SCHEMA,
    revision: 0,
    recentOperations: [],
    runs: [
      {
        runId: 'run-1',
        displayLabel: 'Claude 1',
        worktreePath: root,
        projectRoot: root,
        agent: 'claude',
        launchMode: 'new',
        controllerId: 'cli:boot:1',
        controller: { kind: 'cli', instanceId: '1', pid: 1, bootId: 'boot' },
        lifecycleStatus: 'working',
        activeRuntimeSeconds: 0,
        runtimeSequence: 0,
        startedAt: now,
        lastSeenAt: now,
        status: 'running',
        terminalId: 'terminal-1',
      },
    ],
    sessionId: 'session-1',
    projectRoot: root,
    task: {
      title: 'Task',
      originalRequest: 'Task',
      requirements: [],
      constraints: [],
      status: 'active',
      createdAt: now,
      updatedAt: now,
    },
    git: { startingCommit: 'abc', startingBranch: 'main', dirtyAtStart: false },
    agentHistory: [],
    decisions: [],
    completedWork: [],
    remainingWork: [],
    tests: [],
    checkpoints: [],
    blockers: [],
    notes: [],
  };
}

describe('run message capability', () => {
  it('resolves operator when no managed-run markers are present', async () => {
    const root = await createRepository();
    const oldEnv = { ...process.env };
    try {
      delete process.env.RIREI_PROJECT_ROOT;
      delete process.env.RIREI_TASK_SESSION_ID;
      delete process.env.RIREI_RUN_ID;
      delete process.env.RIREI_MESSAGE_TOKEN;
      delete process.env.RIREI_TERMINAL_ID;
      delete process.env.RIREI_LIFECYCLE_TOKEN;
      delete process.env.RIREI_LIFECYCLE_HOOK;
      const actor = await resolveCurrentActor(root, testState(root));
      expect(actor).toEqual({ kind: 'operator' });
    } finally {
      process.env = oldEnv;
      await removeRepository(root);
    }
  });

  it('issues capability, sets env vars, validates active run, and revokes', async () => {
    const root = await createRepository();
    try {
      const state = testState(root);
      const { token, env } = await issueMessageCapability(
        root,
        state.sessionId,
        'run-1',
        'terminal-1',
      );
      expect(typeof token).toBe('string');

      const oldEnv = { ...process.env };
      try {
        process.env.RIREI_PROJECT_ROOT = env.RIREI_PROJECT_ROOT;
        process.env.RIREI_TASK_SESSION_ID = env.RIREI_TASK_SESSION_ID;
        process.env.RIREI_RUN_ID = env.RIREI_RUN_ID;
        process.env.RIREI_MESSAGE_TOKEN = env.RIREI_MESSAGE_TOKEN;
        process.env.RIREI_TERMINAL_ID = env.RIREI_TERMINAL_ID;

        const actor = await resolveCurrentActor(root, state);
        expect(actor).toEqual({ kind: 'run', runId: 'run-1' });

        // Revoke
        await revokeMessageCapability(root, 'run-1');
        await expect(resolveCurrentActor(root, state)).rejects.toThrow(
          /Capability descriptor not found/,
        );
      } finally {
        process.env = oldEnv;
      }
    } finally {
      await removeRepository(root);
    }
  });

  it('fails closed when capability token is invalid', async () => {
    const root = await createRepository();
    try {
      const state = testState(root);
      await issueMessageCapability(
        root,
        state.sessionId,
        'run-1',
        'terminal-1',
      );

      const oldEnv = { ...process.env };
      try {
        process.env.RIREI_PROJECT_ROOT = root;
        process.env.RIREI_TASK_SESSION_ID = state.sessionId;
        process.env.RIREI_RUN_ID = 'run-1';
        process.env.RIREI_MESSAGE_TOKEN =
          'wrong-token-value-00000000000000000000000000';
        process.env.RIREI_TERMINAL_ID = 'terminal-1';

        await expect(resolveCurrentActor(root, state)).rejects.toThrow(
          /Invalid run capability token/,
        );
      } finally {
        process.env = oldEnv;
      }
    } finally {
      await removeRepository(root);
    }
  });

  it('fails closed when a managed run strips capability variables', async () => {
    const root = await createRepository();
    const oldEnv = { ...process.env };
    try {
      process.env.RIREI_PROJECT_ROOT = root;
      process.env.RIREI_TERMINAL_ID = 'terminal-1';
      delete process.env.RIREI_TASK_SESSION_ID;
      delete process.env.RIREI_RUN_ID;
      delete process.env.RIREI_MESSAGE_TOKEN;
      await expect(resolveCurrentActor(root, testState(root))).rejects.toThrow(
        /Incomplete run capability environment/,
      );
    } finally {
      process.env = oldEnv;
      await removeRepository(root);
    }
  });

  it('rejects a capability used from another terminal', async () => {
    const root = await createRepository();
    const oldEnv = { ...process.env };
    try {
      const state = testState(root);
      const { env } = await issueMessageCapability(
        root,
        state.sessionId,
        'run-1',
        'terminal-1',
      );
      Object.assign(process.env, env, { RIREI_TERMINAL_ID: 'terminal-2' });
      await expect(resolveCurrentActor(root, state)).rejects.toThrow(
        /terminal mismatch/,
      );
    } finally {
      process.env = oldEnv;
      await removeRepository(root);
    }
  });

  it('refuses to overwrite a symlinked capability descriptor', async () => {
    const root = await createRepository();
    try {
      const directory = relayPath(root, 'runtime', 'message-capabilities');
      await mkdir(directory, { recursive: true });
      const target = path.join(root, 'outside.json');
      await writeFile(target, 'unchanged');
      await symlink(target, capabilityDescriptorPath(root, 'run-1'));
      await expect(
        issueMessageCapability(root, 'session-1', 'run-1', 'terminal-1'),
      ).rejects.toThrow(/regular file/);
      await expect(readFile(target, 'utf8')).resolves.toBe('unchanged');
    } finally {
      await removeRepository(root);
    }
  });
});
