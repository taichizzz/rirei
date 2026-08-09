import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SessionManager, type RunSelection } from './application/sessions.js';
import { readConfig } from './config/loader.js';
import { discoverRepository, inspectGitSnapshot } from './git/repository.js';
import { relayPath } from './safety/path-policy.js';
import { appendEvent } from './state/events.js';
import type { RelayState } from './state/schema.js';
import { readState, updateState } from './state/store.js';
import type { AgentAdapter, ProcessResult } from './agents/adapter.js';
import { InheritedProcessHost } from './process/inherited-process-host.js';

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
  label?: string,
): Promise<{ id: string; state: RelayState }> {
  const config = await readConfig(root);
  const snapshot = await inspectGitSnapshot(
    root,
    config.checkpoint.maxPatchBytes,
  );
  const createdAt = new Date().toISOString();
  let id = '';
  const next = await updateState(root, async (current) => {
    id = `${createdAt.replaceAll(':', '-').replaceAll('.', '-')}-${String(current.checkpoints.length + 1).padStart(3, '0')}`;
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
      writeFile(
        path.join(directory, 'diff-stat.txt'),
        `${snapshot.diffStat}\n`,
        { mode: 0o600 },
      ),
      writeFile(path.join(directory, 'changes.patch'), snapshot.patch, {
        mode: 0o600,
      }),
    ]);
    const checkpoints = [
      ...current.checkpoints,
      { id, createdAt, path: relative, label: label || undefined },
    ];
    const discarded = checkpoints.splice(
      0,
      Math.max(0, checkpoints.length - config.checkpoint.maxCount),
    );
    await Promise.all(
      discarded.map((item) =>
        rm(relayPath(root, item.path), { recursive: true, force: true }),
      ),
    );
    return {
      ...current,
      git: {
        ...current.git,
        currentCommit: snapshot.commit,
        currentBranch: snapshot.branch,
      },
      checkpoints,
      task: { ...current.task, updatedAt: createdAt },
    };
  });
  await appendEvent(root, 'checkpoint_created', { id, label: label ?? null });
  return { id, state: next };
}

export async function renderHandoff(
  root: string,
  state: RelayState,
  worktreeRoot = root,
): Promise<string> {
  const config = await readConfig(root);
  const snapshot = await inspectGitSnapshot(
    worktreeRoot,
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
  selection: RunSelection = {},
): Promise<{ result: ProcessResult; state: RelayState }> {
  const manager = new SessionManager(new InheritedProcessHost());
  const managed = await manager.startRun({
    projectRoot: root,
    state,
    adapter,
    prompt,
    selection,
  });
  const completed = await managed.completion;
  if (completed.result.exitCode === 127 && completed.result.stderr)
    throw new Error(completed.result.stderr);
  return { result: completed.result, state: completed.state };
}
