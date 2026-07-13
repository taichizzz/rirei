import { Command } from 'commander';
import { getAgent, isAgentId } from '../agents/registry.js';
import { launchAgent, renderHandoff, taskContext } from '../lifecycle.js';

export function runCommand(): Command {
  return new Command('run')
    .description('Launch an installed official agent CLI for the current task')
    .argument('<agent>', 'claude, codex, or gemini')
    .option(
      '--prompt <prompt>',
      'use an explicit prompt instead of the Relay handoff',
    )
    .action(async (agent: string, options: { prompt?: string }) => {
      if (!isAgentId(agent)) throw new Error(`Unknown agent: ${agent}.`);
      const { root, state } = await taskContext();
      const prompt = options.prompt ?? (await renderHandoff(root, state));
      const { result } = await launchAgent(
        root,
        state,
        getAgent(agent),
        prompt,
      );
      if (result.exitCode !== 0) process.exitCode = result.exitCode ?? 1;
    });
}
