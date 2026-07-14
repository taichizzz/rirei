import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readConfig } from './config/loader.js';
import { discoverRepository, inspectGitSnapshot } from './git/repository.js';
import { relayPath } from './safety/path-policy.js';
import { appendEvent } from './state/events.js';
import type { RelayState } from './state/schema.js';
import { readState, writeState } from './state/store.js';
import type { AgentAdapter, ProcessResult } from './agents/adapter.js';
import { prepareProviderUsage } from './plan-usage.js';

export async function taskContext(): Promise<{
  root: string;
  state: RelayState;
}> {
  const root = await discoverRepository(process.cwd());
  if (!root) throw new Error('Relay must be run inside a Git repository.');
  const state = await readState(root);
  if (state.task.status !== 'active' && state.task.status !== 'blocked')
    throw new Error(`Relay task is ${state.task.status}.`);
  return { root, state };
}

export async function createCheckpoint(
  root: string,
  state: RelayState,
  label?: string,
): Promise<{ id: string; state: RelayState }> {
  const config = await readConfig(root);
  const snapshot = await inspectGitSnapshot(
    root,
    config.checkpoint.maxPatchBytes,
  );
  const createdAt = new Date().toISOString();
  const id = `${createdAt.replaceAll(':', '-').replaceAll('.', '-')}-${String(state.checkpoints.length + 1).padStart(3, '0')}`;
  const relative = path.posix.join('checkpoints', id);
  const directory = relayPath(root, relative);
  await mkdir(directory, { recursive: false, mode: 0o700 });
  const metadata = {
    schemaVersion: 1,
    id,
    createdAt,
    label: label || undefined,
    commit: snapshot.commit,
    branch: snapshot.branch,
    patchTruncated: snapshot.patchTruncated,
  };
  await Promise.all([
    writeFile(
      path.join(directory, 'metadata.json'),
      `${JSON.stringify(metadata, null, 2)}\n`,
      { mode: 0o600 },
    ),
    writeFile(path.join(directory, 'status.txt'), `${snapshot.status}\n`, {
      mode: 0o600,
    }),
    writeFile(path.join(directory, 'diff-stat.txt'), `${snapshot.diffStat}\n`, {
      mode: 0o600,
    }),
    writeFile(path.join(directory, 'changes.patch'), snapshot.patch, {
      mode: 0o600,
    }),
  ]);
  const checkpoints = [...state.checkpoints, { id, createdAt, path: relative }];
  const discarded = checkpoints.splice(
    0,
    Math.max(0, checkpoints.length - config.checkpoint.maxCount),
  );
  await Promise.all(
    discarded.map((item) =>
      rm(relayPath(root, item.path), { recursive: true, force: true }),
    ),
  );
  const next = {
    ...state,
    git: {
      ...state.git,
      currentCommit: snapshot.commit,
      currentBranch: snapshot.branch,
    },
    checkpoints,
    task: { ...state.task, updatedAt: createdAt },
  };
  await writeState(root, next);
  await appendEvent(root, 'checkpoint_created', { id, label: label ?? null });
  return { id, state: next };
}

export async function renderHandoff(
  root: string,
  state: RelayState,
): Promise<string> {
  const config = await readConfig(root);
  const snapshot = await inspectGitSnapshot(
    root,
    config.checkpoint.maxPatchBytes,
  );
  const lines = [
    `# Relay handoff: ${state.task.title}`,
    '',
    state.task.originalRequest,
    '',
    `Status: ${state.task.status}`,
    `Git: ${snapshot.branch} at ${snapshot.commit}`,
    `Changed files:\n${snapshot.status || '(clean)'}`,
    `Diff stat:\n${snapshot.diffStat || '(none)'}`,
    `Completed:\n${state.completedWork.map((item) => `- ${item.description}`).join('\n') || '- None recorded'}`,
    `Remaining:\n${state.remainingWork.map((item) => `- ${item.description}`).join('\n') || '- Refer to original request'}`,
    `Decisions:\n${state.decisions.map((item) => `- ${item.summary}`).join('\n') || '- None recorded'}`,
    `Tests:\n${state.tests.map((item) => `- ${item.status}: ${item.command}`).join('\n') || '- None recorded'}`,
    'Continue from the current working tree. Do not discard existing changes.',
  ];
  const text = `${lines.join('\n')}\n`;
  return text.length <= config.handoff.maxCharacters
    ? text
    : `${text.slice(0, config.handoff.maxCharacters - 28)}\n[Relay handoff truncated]\n`;
}

export async function launchAgent(
  root: string,
  state: RelayState,
  adapter: AgentAdapter,
  prompt: string,
  selection: { model?: string; effort?: string } = {},
): Promise<{ result: ProcessResult; state: RelayState }> {
  const installation = await adapter.detectInstallation();
  if (installation.status !== 'ready')
    throw new Error(
      `${adapter.displayName} CLI is not installed or executable on PATH.`,
    );
  const providerSettingsPath = await prepareProviderUsage(root, adapter.id);
  const spec = await adapter.buildInteractiveCommand({
    projectRoot: root,
    prompt,
    providerSettingsPath,
    model: selection.model,
    effort: selection.effort,
  });
  if (state.currentAgent)
    throw new Error(
      `Agent ${state.currentAgent} is already running for this task.`,
    );
  const startedAt = new Date().toISOString();
  const runId = randomUUID();
  const run = {
    id: runId,
    agent: adapter.id,
    model: selection.model,
    effort: selection.effort,
    startedAt,
  };
  const history = [...state.agentHistory, run];
  let next: RelayState = {
    ...state,
    currentAgent: adapter.id,
    agentHistory: history,
  };
  await writeState(root, next);
  await appendEvent(root, 'agent_started', {
    runId,
    agent: adapter.id,
    model: selection.model ?? null,
    effort: selection.effort ?? null,
  });
  let spawnError: Error | undefined;
  let result: ProcessResult;
  try {
    result = await new Promise<ProcessResult>((resolve, reject) => {
      const child = spawn(spec.executable, spec.args, {
        cwd: root,
        stdio: 'inherit',
      });
      child.once('error', reject);
      child.once('exit', (exitCode, signal) =>
        resolve({ exitCode, signal, stdout: '', stderr: '' }),
      );
    });
  } catch (error) {
    spawnError = error instanceof Error ? error : new Error(String(error));
    result = {
      exitCode: 127,
      signal: null,
      stdout: '',
      stderr: spawnError.message,
    };
  }
  const classification = await adapter.classifyExit(result);
  const completedRun = {
    ...run,
    endedAt: new Date().toISOString(),
    exitCode: result.exitCode,
    exitReason: classification.reason,
  };
  const latest = await readState(root);
  const found = latest.agentHistory.some((item) => item.id === runId);
  const mergedHistory = found
    ? latest.agentHistory.map((item) =>
        item.id === runId ? completedRun : item,
      )
    : [...latest.agentHistory, completedRun];
  next = {
    ...latest,
    currentAgent:
      latest.currentAgent === adapter.id ? undefined : latest.currentAgent,
    agentHistory: mergedHistory,
  };
  await writeState(root, next);
  await appendEvent(root, 'agent_ended', {
    runId,
    agent: adapter.id,
    exitCode: result.exitCode,
    reason: classification.reason,
  });
  if (spawnError) throw spawnError;
  return { result, state: next };
}
