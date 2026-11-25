import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
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
  discoverRepositoryAuthority,
  ensureRelayLocalExclusion,
  inspectGitSnapshot,
  type GitSnapshot,
} from './git/repository.js';
import {
  buildHandoffCapsule,
  handoffContentChecks,
  renderCompactHandoff,
  type RenderedHandoff,
} from './handoff.js';
import { relayPath } from './safety/path-policy.js';
import { appendEvent } from './state/events.js';
import type { RelayState } from './state/schema.js';
import { readState, updateState } from './state/store.js';
import type { AgentAdapter, ProcessResult } from './agents/adapter.js';
import type { PreflightLimitWarning } from './agents/limit-detection.js';
import { InheritedProcessHost } from './process/inherited-process-host.js';
import {
  loadContinuitySources,
  renderContinuityContext,
} from './context/render.js';
import { CONTEXT_PROMPT_LIMIT } from './context/schema.js';
import { inspectVerificationState } from './context/verification.js';
import { inspectCoveredSnapshot } from './context/snapshot.js';
import { inspectionAnchor, inspectionBriefing } from './context/inspection.js';
import {
  applyHandoffPolicy,
  parseHandoffProfile,
  stableLayoutProfile,
  type HandoffProfile,
} from './context/prompt-policy.js';

export async function taskContext(
  options: {
    ensureExclusion?: boolean;
    allowClosed?: boolean;
  } = {},
): Promise<{
  root: string;
  state: RelayState;
}> {
  const rootHint = process.env.RIREI_PROJECT_ROOT?.trim();
  const discoveredRoot = rootHint
    ? await discoverRepository(rootHint)
    : await discoverRepositoryAuthority(process.cwd());
  if (!discoveredRoot)
    throw new Error('Relay must be run inside a Git repository.');
  let root = discoveredRoot;
  if (rootHint) {
    const [canonicalRoot, canonicalHint] = await Promise.all([
      realpath(discoveredRoot),
      realpath(rootHint),
    ]);
    if (canonicalRoot !== canonicalHint)
      throw new Error(
        'RIREI_PROJECT_ROOT must identify a Git repository root.',
      );
    root = path.resolve(rootHint);
  }
  if (options.ensureExclusion !== false) await ensureRelayLocalExclusion(root);
  const state = await readState(root);
  if (
    !options.allowClosed &&
    state.task.status !== 'active' &&
    state.task.status !== 'blocked'
  )
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
  options: { profile?: HandoffProfile } = {},
): Promise<RenderedHandoff> {
  const profile = parseHandoffProfile(options.profile);
  const config = await readConfig(root);
  const snapshot =
    capturedSnapshot ??
    (await inspectGitSnapshot(worktreeRoot, config.checkpoint.maxPatchBytes));
  const sources = await loadContinuitySources(
    root,
    state.sessionId,
    worktreeRoot,
    snapshot.fingerprint,
  );
  const covered = sources
    ? await inspectCoveredSnapshot(
        worktreeRoot,
        {},
        { inspection: { includeText: false } },
      )
    : undefined;
  const verification =
    state.tests.length || state.verificationReceipts?.length
      ? await inspectVerificationState(
          state,
          worktreeRoot,
          config.tests.command ?? null,
          undefined,
          covered?.identity,
        )
      : undefined;
  const capsule = buildHandoffCapsule(
    state,
    snapshot,
    config.handoff.maxChangedFiles,
  );
  if (verification) capsule.verification = verification.summaries;
  const rendered = renderCompactHandoff(capsule, config.handoff);
  if (covered || verification?.snapshot)
    rendered.coveredSnapshot = covered?.identity ?? verification!.snapshot;
  const anchor = covered ? inspectionAnchor(covered) : undefined;
  if (anchor) rendered.inspection = anchor;
  const continuity = sources
    ? renderContinuityContext(
        sources,
        anchor ? inspectionBriefing(anchor) : [],
        { includePresentation: stableLayoutProfile(profile) },
      )
    : undefined;
  const presentation = continuity?.presentation;
  if (continuity) delete continuity.presentation;
  const compose = async (base: RenderedHandoff) =>
    profile === 'control'
      ? base
      : applyHandoffPolicy(base, {
          profile,
          workspace: sources?.workspace ?? (await realpath(worktreeRoot)),
          legacyText: rendered.text,
          legacyMaxCharacters: rendered.budget.maxCharacters,
          presentation,
        });
  if (!continuity) return compose(rendered);
  const text = `${rendered.text.trimEnd()}\n\n${continuity.text}\n`;
  return compose({
    ...rendered,
    continuity,
    text,
    contentChecks: handoffContentChecks(text, state.task.originalRequest),
    budget: {
      ...rendered.budget,
      maxCharacters: rendered.budget.maxCharacters + CONTEXT_PROMPT_LIMIT + 3,
      maxTokens:
        rendered.budget.maxTokens + Math.ceil((CONTEXT_PROMPT_LIMIT + 3) / 4),
      usedCharacters: text.length,
      estimatedTokens: Math.ceil(text.length / 4),
      omittedItems:
        rendered.budget.omittedItems +
        continuity.omittedEvents +
        (continuity.omittedStateItems ?? 0),
    },
  });
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
): Promise<{
  result: ProcessResult;
  state: RelayState;
  warning?: PreflightLimitWarning;
}> {
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
  try {
    const managed = await manager.startRun({
      projectRoot: root,
      state,
      adapter,
      prompt,
      selection,
      controller,
    });
    heartbeat.start();
    const completed = await managed.completion;
    if (completed.result.spawnErrorCode)
      throw new Error(
        `${adapter.displayName} could not start (${completed.result.spawnErrorCode}).`,
      );
    return {
      result: completed.result,
      state: completed.state,
      warning: managed.warning,
    };
  } finally {
    heartbeat.stop();
    await heartbeat.orphanOwned().catch(() => undefined);
    process.off('SIGUSR1', userInterrupt);
    process.off('SIGUSR2', userStop);
    process.off('SIGHUP', controllerLoss);
  }
}
