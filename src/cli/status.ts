import { Command } from 'commander';
import { discoverRepository, inspectGitBaseline } from '../git/repository.js';
import { readState } from '../state/store.js';

export function statusCommand(): Command {
  return new Command('status')
    .description('Display current Relay task status')
    .option('--json', 'print machine-readable JSON')
    .action(async (options: { json?: boolean }) => {
      const projectRoot = await discoverRepository(process.cwd());
      if (!projectRoot)
        throw new Error('Relay must be run inside a Git repository.');
      const [state, git] = await Promise.all([
        readState(projectRoot),
        inspectGitBaseline(projectRoot),
      ]);
      const latestTest = state.tests.at(-1);
      const latestCheckpoint = state.checkpoints.at(-1);
      const previousAgents = [
        ...new Set(state.agentHistory.map((record) => record.agent)),
      ];
      const activeNotes = state.notes.filter((note) => !note.resolvedAt);
      const completedWork = [
        ...state.completedWork,
        ...state.notes
          .filter((note) => note.type === 'done')
          .map((note) => ({
            description: note.text,
            updatedAt: note.createdAt,
          })),
      ];
      const remainingWork = [
        ...state.remainingWork,
        ...activeNotes
          .filter((note) => note.type === 'next')
          .map((note) => ({
            description: note.text,
            updatedAt: note.createdAt,
          })),
      ];
      const decisions = [
        ...state.decisions,
        ...state.notes
          .filter((note) => note.type === 'decision')
          .map((note) => ({
            summary: note.text,
            rationale: note.reason,
            createdAt: note.createdAt,
          })),
      ];
      const blockers = [
        ...state.blockers,
        ...activeNotes
          .filter((note) => note.type === 'blocker')
          .map((note) => ({
            description: note.text,
            createdAt: note.createdAt,
          })),
      ];
      if (options.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              generatedAt: new Date().toISOString(),
              sessionId: state.sessionId,
              task: state.task,
              git: {
                startingCommit: state.git.startingCommit,
                currentCommit: git.commit,
                startingBranch: state.git.startingBranch,
                currentBranch: git.branch,
                dirtyAtStart: state.git.dirtyAtStart,
                dirty: git.dirty,
                changedFiles: git.changedFiles,
              },
              runs: state.runs,
              currentAgent: state.currentAgent ?? null,
              currentRunId: state.currentRunId ?? null,
              previousAgents,
              agentHistory: state.agentHistory,
              latestTest: latestTest ?? null,
              latestCheckpoint: latestCheckpoint ?? null,
              checkpointCount: state.checkpoints.length,
              checkpoints: state.checkpoints,
              completedWork,
              remainingWork,
              decisions,
              blockers,
              rejectedApproaches: activeNotes.filter(
                (note) => note.type === 'rejected',
              ),
              questions: activeNotes.filter((note) => note.type === 'question'),
              notes: state.notes,
            },
            null,
            2,
          )}\n`,
        );
        return;
      }
      const lines = [
        `Session ID: ${state.sessionId}`,
        `Task: ${state.task.title}`,
        `Status: ${state.task.status}`,
        `Current agent: ${state.currentAgent ?? 'None'}`,
        `Active runs: ${
          state.runs.length === 0
            ? 'None'
            : state.runs
                .map(
                  (lease) =>
                    `${lease.agent} (${lease.status}) in ${lease.workspaceId ?? 'main working tree'}`,
                )
                .join('; ')
        }`,
        `Previous agents: ${previousAgents.join(', ') || 'None'}`,
        `Starting commit: ${state.git.startingCommit}`,
        `Current commit: ${git.commit}`,
        `Current branch: ${git.branch}`,
        `Changed files: ${git.changedFiles}`,
        `Changed-file baseline: ${state.git.dirtyAtStart ? 'dirty' : 'clean'}`,
        `Latest test: ${latestTest ? `${latestTest.status} (${latestTest.command})` : 'None'}`,
        `Latest checkpoint: ${latestCheckpoint?.id ?? 'None'}`,
        `Completed items: ${completedWork.length}`,
        `Remaining items: ${remainingWork.length}`,
        `Decisions: ${decisions.length}`,
        `Blockers: ${blockers.length}`,
        `Rejected approaches: ${activeNotes.filter((note) => note.type === 'rejected').length}`,
        `Open questions: ${activeNotes.filter((note) => note.type === 'question').length}`,
      ];
      process.stdout.write(`${lines.join('\n')}\n`);
    });
}
