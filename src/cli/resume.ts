import { Command } from 'commander';
import type { ResumeTargetKind } from '../agents/adapter.js';
import { getAgent, isAgentId } from '../agents/registry.js';
import { launchAgent, taskContext } from '../lifecycle.js';
import { resolveWorkspace } from '../worktrees/registry.js';

interface ResumeOptions {
  latest?: boolean;
  id?: string;
  picker?: boolean;
  fork?: boolean;
  prompt?: string;
  model?: string;
  effort?: string;
  operationId?: string;
  terminalId?: string;
  workspace?: string;
}

export function resumeCommand(): Command {
  return new Command('resume')
    .description('Resume a supported provider session')
    .argument('<agent>', 'an agent that supports session resume')
    .option('--latest', 'resume the latest provider session')
    .option('--id <value>', 'resume an exact provider session ID')
    .option('--picker', 'open the provider session picker')
    .option('--fork', 'fork the selected provider session')
    .option('--prompt <prompt>', 'send an explicit prompt after resuming')
    .option('--model <model>', 'override the provider model for this session')
    .option('--effort <level>', 'override reasoning effort when supported')
    .option('--operation-id <id>', 'idempotency key for this provider launch')
    .option('--terminal-id <id>', 'terminal that owns this provider launch')
    .option('--workspace <id>', 'resume inside the original Rirei workspace')
    .action(async (agent: string, options: ResumeOptions) => {
      if (!isAgentId(agent)) throw new Error(`Unknown agent: ${agent}.`);
      const adapter = getAgent(agent);
      const capabilities = adapter.resumeCapabilities;
      if (!capabilities || !adapter.buildResumeCommand)
        throw new Error(
          `${adapter.displayName} does not support session resume.`,
        );
      const selectedTargets = [
        options.latest,
        options.id,
        options.picker,
      ].filter(Boolean);
      if (selectedTargets.length > 1)
        throw new Error('Choose only one of --latest, --id, or --picker.');
      if (
        options.id !== undefined &&
        (!options.id || options.id.startsWith('-'))
      )
        throw new Error(
          'Resume session IDs must be non-empty and cannot start with a dash.',
        );
      const defaultTarget: ResumeTargetKind = capabilities.targets.includes(
        'picker',
      )
        ? 'picker'
        : 'latest';
      const resumeTargetKind: ResumeTargetKind = options.latest
        ? 'latest'
        : options.id
          ? 'id'
          : options.picker
            ? 'picker'
            : defaultTarget;
      if (!capabilities.targets.includes(resumeTargetKind))
        throw new Error(
          `${adapter.displayName} does not support ${resumeTargetKind} session resume.`,
        );
      if (options.fork && !capabilities.supportsFork)
        throw new Error(
          `${adapter.displayName} session forks are not supported.`,
        );
      const context = await taskContext();
      const workspace = options.workspace
        ? await resolveWorkspace(
            context.root,
            options.workspace,
            context.state.sessionId,
          )
        : undefined;
      const { result } = await launchAgent(
        context.root,
        context.state,
        adapter,
        options.prompt ?? '',
        {
          model: options.model,
          effort: options.effort,
          launchMode: options.fork ? 'fork' : 'resume',
          resumeTargetKind,
          resumeTargetValue: options.id,
          operationId: options.operationId,
          terminalId: options.terminalId,
          workspace,
        },
      );
      if (result.exitCode !== 0) process.exitCode = result.exitCode ?? 1;
    });
}
