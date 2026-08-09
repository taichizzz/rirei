import { Command } from 'commander';
import type { ResumeTargetKind } from '../agents/adapter.js';
import { getAgent, isAgentId } from '../agents/registry.js';
import { launchAgent, taskContext } from '../lifecycle.js';

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
}

export function resumeCommand(): Command {
  return new Command('resume')
    .description('Resume a Claude or Codex provider session')
    .argument('<agent>', 'claude or codex')
    .option('--latest', 'resume the latest provider session')
    .option('--id <value>', 'resume an exact provider session ID')
    .option('--picker', 'open the provider session picker')
    .option('--fork', 'fork the selected Claude session')
    .option('--prompt <prompt>', 'send an explicit prompt after resuming')
    .option('--model <model>', 'override the provider model for this session')
    .option('--effort <level>', 'override reasoning effort when supported')
    .option('--operation-id <id>', 'idempotency key for this provider launch')
    .option('--terminal-id <id>', 'terminal that owns this provider launch')
    .action(async (agent: string, options: ResumeOptions) => {
      if (!isAgentId(agent) || (agent !== 'claude' && agent !== 'codex'))
        throw new Error('Session resume currently supports claude and codex.');
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
      if (options.fork && agent === 'codex')
        throw new Error('Codex session forks are not supported.');
      const resumeTargetKind: ResumeTargetKind = options.latest
        ? 'latest'
        : options.id
          ? 'id'
          : 'picker';
      const context = await taskContext();
      const { result } = await launchAgent(
        context.root,
        context.state,
        getAgent(agent),
        options.prompt ?? '',
        {
          model: options.model,
          effort: options.effort,
          launchMode: options.fork ? 'fork' : 'resume',
          resumeTargetKind,
          resumeTargetValue: options.id,
          operationId: options.operationId,
          terminalId: options.terminalId,
        },
      );
      if (result.exitCode !== 0) process.exitCode = result.exitCode ?? 1;
    });
}
