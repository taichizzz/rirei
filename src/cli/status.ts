import { Command } from 'commander';
import { discoverRepository, inspectGitBaseline } from '../git/repository.js';
import { readState } from '../state/store.js';

export function statusCommand(): Command {
  return new Command('status')
    .description('Display current Relay task status')
    .action(async () => {
      const projectRoot = await discoverRepository(process.cwd());
      if (!projectRoot)
        throw new Error('Relay must be run inside a Git repository.');
      const [state, git] = await Promise.all([
        readState(projectRoot),
        inspectGitBaseline(projectRoot),
      ]);
      const latestTest = state.tests.at(-1);
      const latestCheckpoint = state.checkpoints.at(-1);
      const lines = [
        `Session ID: ${state.sessionId}`,
        `Task: ${state.task.title}`,
        `Status: ${state.task.status}`,
        `Current agent: ${state.currentAgent ?? 'None'}`,
        `Previous agents: ${state.agentHistory.map((record) => record.agent).join(', ') || 'None'}`,
        `Starting commit: ${state.git.startingCommit}`,
        `Current commit: ${git.commit}`,
        `Current branch: ${git.branch}`,
        `Changed-file baseline: ${state.git.dirtyAtStart ? 'dirty' : 'clean'}`,
        `Latest test: ${latestTest ? `${latestTest.status} (${latestTest.command})` : 'None'}`,
        `Latest checkpoint: ${latestCheckpoint?.id ?? 'None'}`,
        `Completed items: ${state.completedWork.length}`,
        `Remaining items: ${state.remainingWork.length}`,
        `Decisions: ${state.decisions.length}`,
        `Blockers: ${state.blockers.length}`,
      ];
      process.stdout.write(`${lines.join('\n')}\n`);
    });
}
