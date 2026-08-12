import { access, constants } from 'node:fs/promises';
import { Command } from 'commander';
import {
  discoverRepository,
  ensureRelayLocalExclusion,
  inspectGitBaseline,
} from '../git/repository.js';
import { relayPath } from '../safety/path-policy.js';
import { appendEvent } from '../state/events.js';
import { LATEST_STATE_SCHEMA, type RelayState } from '../state/schema.js';
import { replaceState } from '../state/store.js';

function titleFromRequest(request: string): string {
  return request.split(/\r?\n/, 1)[0]?.trim() || request;
}

export function startCommand(): Command {
  return new Command('start')
    .description('Start a durable Relay task')
    .argument('<task>', 'original task request')
    .option('--allow-dirty', 'allow a task to begin with uncommitted changes')
    .action(async (task: string, options: { allowDirty?: boolean }) => {
      const projectRoot = await discoverRepository(process.cwd());
      if (!projectRoot)
        throw new Error('Relay must be run inside a Git repository.');
      try {
        await access(relayPath(projectRoot, 'config.json'), constants.R_OK);
      } catch {
        throw new Error('Relay is not initialized. Run relay init first.');
      }
      await ensureRelayLocalExclusion(projectRoot);
      const baseline = await inspectGitBaseline(projectRoot);

      if (baseline.dirty && !options.allowDirty) {
        throw new Error(
          'The working tree is dirty. Review it and rerun with --allow-dirty to record that baseline.',
        );
      }

      const now = new Date().toISOString();
      const state = await replaceState(baseline.root, (existing) => {
        if (existing) {
          if (
            existing.task.status === 'active' ||
            existing.task.status === 'blocked'
          ) {
            throw new Error(
              'An active Relay task was found. Finish or cancel it before starting another task.',
            );
          }
          if (existing.runs.length > 0)
            throw new Error(
              'A provider run still owns a working tree. Stop it or recover its orphaned lease before starting another task.',
            );
        }
        const replacement: RelayState = {
          schemaVersion: LATEST_STATE_SCHEMA,
          revision: 0,
          recentOperations: [],
          runs: [],
          sessionId: crypto.randomUUID(),
          projectRoot: baseline.root,
          task: {
            title: titleFromRequest(task),
            originalRequest: task,
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
        return replacement;
      });
      await appendEvent(baseline.root, 'task_started', {
        sessionId: state.sessionId,
        task: state.task.title,
        dirtyAtStart: baseline.dirty,
      });
      process.stdout.write(`Started Relay task ${state.sessionId}\n`);
      if (baseline.dirty)
        process.stdout.write(
          'Warning: the working tree was already dirty at task start.\n',
        );
    });
}
