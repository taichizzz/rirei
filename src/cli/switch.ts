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
    .argument('<agent>', 'claude, codex, or gemini')
    .action(async (agent: string) => {
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
      );
      if (result.exitCode !== 0) process.exitCode = result.exitCode ?? 1;
    });
}
