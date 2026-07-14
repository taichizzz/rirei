import { Command } from 'commander';
import { getAgent, isAgentId } from '../agents/registry.js';
import {
  createCheckpoint,
  launchAgent,
  renderHandoff,
  taskContext,
} from '../lifecycle.js';

export function switchCommand(): Command {
  return new Command('switch')
    .description('Checkpoint, preview a handoff, and launch another agent')
    .argument('<agent>', 'claude, codex, gemini, or antigravity')
    .option('--model <model>', 'override the provider model for this session')
    .option('--effort <level>', 'override reasoning effort when supported')
    .action(
      async (agent: string, options: { model?: string; effort?: string }) => {
        if (!isAgentId(agent)) throw new Error(`Unknown agent: ${agent}.`);
        const context = await taskContext();
        const checkpoint = await createCheckpoint(
          context.root,
          context.state,
          `Switch to ${agent}`,
        );
        const handoff = await renderHandoff(context.root, checkpoint.state);
        process.stdout.write(
          `Checkpoint: ${checkpoint.id}\n\n${handoff}\nLaunching ${agent}...\n`,
        );
        const { result } = await launchAgent(
          context.root,
          checkpoint.state,
          getAgent(agent),
          handoff,
          { model: options.model, effort: options.effort },
        );
        if (result.exitCode !== 0) process.exitCode = result.exitCode ?? 1;
      },
    );
}
