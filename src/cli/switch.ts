import { Command } from 'commander';
import { createInterface } from 'node:readline/promises';
import { isDeepStrictEqual } from 'node:util';
import { getAgent, isAgentId } from '../agents/registry.js';
import { inspectGitSnapshot } from '../git/repository.js';
import {
  handoffStateFingerprint,
  hasContinuationNotes,
  type RenderedHandoff,
} from '../handoff.js';
import {
  createCheckpoint,
  launchAgent,
  renderHandoffDocument,
  taskContext,
} from '../lifecycle.js';
import { readState } from '../state/store.js';

export async function verifySwitchPreview(
  projectRoot: string,
  approved: RenderedHandoff,
) {
  const [latestState, latestSnapshot] = await Promise.all([
    readState(projectRoot),
    inspectGitSnapshot(projectRoot, 1),
  ]);
  const latestHandoff = await renderHandoffDocument(
    projectRoot,
    latestState,
    projectRoot,
    latestSnapshot,
  );
  if (!isDeepStrictEqual(latestHandoff, approved))
    throw new Error(
      'Handoff-relevant state or Git changed after the preview. Run relay switch again to review a fresh handoff.',
    );
  return latestState;
}

export function switchCommand(): Command {
  return new Command('switch')
    .description('Checkpoint, preview a handoff, and launch another agent')
    .argument('<agent>', 'claude, codex, gemini, antigravity, or opencode')
    .option('--model <model>', 'override the provider model for this session')
    .option('--effort <level>', 'override reasoning effort when supported')
    .option('--operation-id <id>', 'idempotency key for this provider launch')
    .option('--terminal-id <id>', 'terminal that owns this provider launch')
    .option('--yes', 'launch without an interactive confirmation')
    .option(
      '--allow-empty-notes',
      'launch even when no continuation notes were recorded',
    )
    .action(
      async (
        agent: string,
        options: {
          model?: string;
          effort?: string;
          operationId?: string;
          terminalId?: string;
          yes?: boolean;
          allowEmptyNotes?: boolean;
        },
      ) => {
        if (!isAgentId(agent)) throw new Error(`Unknown agent: ${agent}.`);
        const context = await taskContext();
        const checkpoint = await createCheckpoint(
          context.root,
          `Switch to ${agent}`,
        );
        const handoff = await renderHandoffDocument(
          context.root,
          checkpoint.state,
          context.root,
          checkpoint.snapshot,
        );
        const expectedHandoffStateFingerprint = handoffStateFingerprint(
          checkpoint.state,
        );
        const hasNotes = hasContinuationNotes(handoff.capsule.notes);
        process.stdout.write(
          `Checkpoint: ${checkpoint.id}\nEstimated handoff: ${handoff.budget.estimatedTokens} tokens (${handoff.budget.usedCharacters} characters)` +
            `${handoff.budget.omittedItems ? `; ${handoff.budget.omittedItems} items omitted` : ''}\n\n${handoff.text}\n`,
        );
        if (!hasNotes && !options.allowEmptyNotes) {
          process.stdout.write(
            '\nNote: this handoff contains only Git-recoverable context; no continuation notes were recorded.\n',
          );
          if (options.yes)
            throw new Error(
              'Refusing to launch with an empty continuation context. Record a relay note (next, blocker, rejected, decision, or question) or rerun with --allow-empty-notes.',
            );
        }
        if (!options.yes) {
          if (!process.stdin.isTTY || !process.stdout.isTTY)
            throw new Error(
              'Switch confirmation requires an interactive terminal. Review the preview and rerun with --yes to launch non-interactively.',
            );
          const prompt = createInterface({
            input: process.stdin,
            output: process.stdout,
          });
          const suffix =
            hasNotes || options.allowEmptyNotes
              ? ''
              : ' (no continuation notes recorded)';
          const answer = await prompt.question(
            `Launch ${agent}? [y/N]${suffix} `,
          );
          prompt.close();
          if (!/^y(?:es)?$/i.test(answer.trim())) {
            process.stdout.write('Launch cancelled; checkpoint retained.\n');
            return;
          }
        }
        const latestState = await verifySwitchPreview(context.root, handoff);
        process.stdout.write(`Launching ${agent}...\n`);
        const { result } = await launchAgent(
          context.root,
          latestState,
          getAgent(agent),
          handoff.text,
          {
            model: options.model,
            effort: options.effort,
            operationId: options.operationId,
            terminalId: options.terminalId,
            expectedHandoffStateFingerprint,
          },
        );
        if (result.exitCode !== 0) process.exitCode = result.exitCode ?? 1;
      },
    );
}
