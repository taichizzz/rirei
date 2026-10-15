import { access, constants, lstat, mkdir } from 'node:fs/promises';
import { defaultConfig } from '../config/schema.js';
import { readConfig, writeConfig } from '../config/loader.js';
import {
  discoverRepository,
  discoverRepositoryAuthority,
  ensureRelayLocalExclusion,
  inspectGitBaseline,
  installRelayLocalExclusion,
} from '../git/repository.js';
import { RELAY_DIRECTORY, relayPath } from '../safety/path-policy.js';
import { appendEvent } from '../state/events.js';
import { LATEST_STATE_SCHEMA, type RelayState } from '../state/schema.js';
import { readState, replaceState } from '../state/store.js';

/** Shared by `relay init` and the TUI's first-run setup. */
export async function initializeProject(cwd: string): Promise<string> {
  const root = await discoverRepository(cwd);
  if (!root)
    throw new Error('Relay must be initialized inside a Git repository.');
  await installRelayLocalExclusion(root);
  const directory = relayPath(root);
  try {
    const existing = await lstat(directory);
    throw new Error(
      existing.isDirectory()
        ? `${RELAY_DIRECTORY} already exists; refusing to overwrite Relay state.`
        : `${RELAY_DIRECTORY} exists but is not a directory.`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(directory, { mode: 0o700 });
  await mkdir(relayPath(root, 'checkpoints'), { mode: 0o700 });
  await mkdir(relayPath(root, 'test-output'), { mode: 0o700 });
  await writeConfig(root, defaultConfig);
  await access(directory, constants.W_OK);
  return root;
}

/** Uses the same dirty-baseline, task replacement, and run-lease gates as the CLI. */
export async function startTask(
  cwd: string,
  task: string,
  options: { allowDirty?: boolean } = {},
): Promise<RelayState> {
  const request = task;
  if (!request.trim()) throw new Error('Describe the task before starting it.');
  const root = await discoverRepository(cwd);
  if (!root) throw new Error('Relay must be run inside a Git repository.');
  try {
    await access(relayPath(root, 'config.json'), constants.R_OK);
  } catch {
    throw new Error('Relay is not initialized. Run relay init first.');
  }
  await ensureRelayLocalExclusion(root);
  const baseline = await inspectGitBaseline(root);
  if (baseline.dirty && !options.allowDirty)
    throw new Error(
      'The working tree is dirty. Review it and rerun with --allow-dirty to record that baseline.',
    );
  const now = new Date().toISOString();
  const state = await replaceState(root, (existing) => {
    if (existing) {
      if (
        existing.task.status === 'active' ||
        existing.task.status === 'blocked'
      )
        throw new Error(
          'An active Relay task was found. Finish or cancel it before starting another task.',
        );
      if (existing.runs.length > 0)
        throw new Error(
          'A provider run still owns a working tree. Stop it or recover its orphaned lease before starting another task.',
        );
    }
    return {
      schemaVersion: LATEST_STATE_SCHEMA,
      revision: 0,
      recentOperations: [],
      runs: [],
      sessionId: crypto.randomUUID(),
      projectRoot: root,
      task: {
        title: request.split(/\r?\n/, 1)[0]?.trim() || request,
        originalRequest: request,
        requirements: [],
        constraints: [],
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
      git: {
        startingCommit: baseline.commit,
        currentCommit: baseline.commit,
        startingBranch: baseline.branch,
        currentBranch: baseline.branch,
        dirtyAtStart: baseline.dirty,
      },
      agentHistory: [],
      decisions: [],
      completedWork: [],
      remainingWork: [],
      tests: [],
      checkpoints: [],
      blockers: [],
      notes: [],
    };
  });
  await appendEvent(root, 'task_started', {
    sessionId: state.sessionId,
    task: state.task.title,
    dirtyAtStart: baseline.dirty,
  });
  return state;
}

export type ProjectSetupState =
  | { stage: 'not_repository'; project: string }
  | { stage: 'initialize'; project: string }
  | { stage: 'task'; project: string; dirty: boolean }
  | { stage: 'ready'; project: string; taskTitle: string }
  | { stage: 'error'; project: string; detail: string };

/** Read-only inspection; simply opening the TUI never initializes or replaces a task. */
export async function inspectProjectSetup(
  cwd: string,
): Promise<ProjectSetupState> {
  try {
    const root = await discoverRepositoryAuthority(cwd);
    if (!root) return { stage: 'not_repository', project: cwd };
    try {
      await lstat(relayPath(root));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { stage: 'initialize', project: root };
      throw error;
    }
    await readConfig(root);
    let state;
    try {
      state = await readState(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (state && ['active', 'blocked'].includes(state.task.status))
      return { stage: 'ready', project: root, taskTitle: state.task.title };
    if (state?.runs.length)
      throw new Error(
        'A run still owns a working tree. Stop or recover it before starting a task.',
      );
    const baseline = await inspectGitBaseline(root);
    return { stage: 'task', project: root, dirty: baseline.dirty };
  } catch (error) {
    return {
      stage: 'error',
      project: cwd,
      detail:
        error instanceof Error
          ? error.message
          : 'Project setup could not be read.',
    };
  }
}
