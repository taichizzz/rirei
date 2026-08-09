import { Command } from 'commander';
import { getAgent, isAgentId } from '../agents/registry.js';
import { launchAgent, renderHandoff, taskContext } from '../lifecycle.js';
import { resolveWorkspace } from '../worktrees/registry.js';

export function runCommand(): Command {
  return new Command('run')
    .description('Launch an installed official agent CLI for the current task')
    .argument('<agent>', 'claude, codex, gemini, or antigravity')
    .option(
      '--prompt <prompt>',
      'use an explicit prompt instead of the Relay handoff',
    )
    .option('--model <model>', 'override the provider model for this session')
    .option('--effort <level>', 'override reasoning effort when supported')
    .option('--operation-id <id>', 'idempotency key for this provider launch')
    .option('--terminal-id <id>', 'terminal that owns this provider launch')
    .option(
      '--workspace <id>',
      'run inside a Rirei workspace worktree instead of the main working tree',
    )
    .action(
      async (
        agent: string,
        options: {
          prompt?: string;
          model?: string;
          effort?: string;
          workspace?: string;
          operationId?: string;
          terminalId?: string;
        },
      ) => {
        if (!isAgentId(agent)) throw new Error(`Unknown agent: ${agent}.`);
        const { root, state } = await taskContext();
        const workspace = options.workspace
          ? await resolveWorkspace(root, options.workspace, state.sessionId)
          : undefined;
        const prompt =
          options.prompt ??
          (await renderHandoff(root, state, workspace?.worktreePath));
        const { result } = await launchAgent(
          root,
          state,
          getAgent(agent),
          prompt,
          {
            model: options.model,
            effort: options.effort,
            workspace,
            operationId: options.operationId,
            terminalId: options.terminalId,
          },
        );
        if (result.exitCode !== 0) process.exitCode = result.exitCode ?? 1;
      },
    );
}
