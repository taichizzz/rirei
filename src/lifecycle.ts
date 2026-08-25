import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SessionManager, type RunSelection } from './application/sessions.js';
import {
  buildControllerIdentity,
  controllerIdFor,
} from './application/controller.js';
import { ControllerHeartbeat } from './application/heartbeat.js';
import { readConfig } from './config/loader.js';
import {
  discoverRepository,
  ensureRelayLocalExclusion,
  inspectGitSnapshot,
  type GitSnapshot,
} from './git/repository.js';
import {
  buildHandoffCapsule,
  renderCompactHandoff,
  type RenderedHandoff,
} from './handoff.js';
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
  await ensureRelayLocalExclusion(root);
  const state = await readState(root);
  if (state.task.status !== 'active' && state.task.status !== 'blocked')
    throw new Error(`Relay task is ${state.task.status}.`);
  return { root, state };
}

export async function createCheckpoint(
  root: string,
  label?: string,
): Promise<{ id: string; state: RelayState; snapshot: GitSnapshot }> {
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
      fingerprint: snapshot.fingerprint,
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
  return { id, state: next, snapshot };
}

export async function renderHandoffDocument(
  root: string,
  state: RelayState,
  worktreeRoot = root,
  capturedSnapshot?: GitSnapshot,
): Promise<RenderedHandoff> {
  const config = await readConfig(root);
  const snapshot =
    capturedSnapshot ??
    (await inspectGitSnapshot(worktreeRoot, config.checkpoint.maxPatchBytes));
  return renderCompactHandoff(
    buildHandoffCapsule(state, snapshot, config.handoff.maxChangedFiles),
    config.handoff,
  );
}

export async function renderHandoff(
  root: string,
  state: RelayState,
  worktreeRoot = root,
): Promise<string> {
  return (await renderHandoffDocument(root, state, worktreeRoot)).text;
}

export async function launchAgent(
  root: string,
  state: RelayState,
  adapter: AgentAdapter,
  prompt: string,
  selection: RunSelection = {},
): Promise<{ result: ProcessResult; state: RelayState }> {
  const controller = buildControllerIdentity({
    terminalId: selection.terminalId,
  });
  const host = new InheritedProcessHost();
  const manager = new SessionManager(host);
  const userInterrupt = () => host.setTerminationIntent('user_interrupt');
  const userStop = () => host.setTerminationIntent('user_stop');
  const controllerLoss = () => host.setTerminationIntent('controller_loss');
  process.on('SIGUSR1', userInterrupt);
  process.on('SIGUSR2', userStop);
  process.on('SIGHUP', controllerLoss);
  const heartbeat = new ControllerHeartbeat(root, controllerIdFor(controller));
  heartbeat.start();
  try {
    const managed = await manager.startRun({
      projectRoot: root,
      state,
      adapter,
      prompt,
      selection,
      controller,
    });
    const completed = await managed.completion;
    if (completed.result.spawnErrorCode)
      throw new Error(
        `${adapter.displayName} could not start (${completed.result.spawnErrorCode}).`,
      );
    return { result: completed.result, state: completed.state };
  } finally {
    heartbeat.stop();
    await heartbeat.orphanOwned().catch(() => undefined);
    process.off('SIGUSR1', userInterrupt);
    process.off('SIGUSR2', userStop);
    process.off('SIGHUP', controllerLoss);
  }
}
