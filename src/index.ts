#!/usr/bin/env node
import { Command } from 'commander';
import { doctorCommand } from './cli/doctor.js';
import { initCommand } from './cli/init.js';
import { startCommand } from './cli/start.js';
import { statusCommand } from './cli/status.js';
import { checkpointCommand } from './cli/checkpoint.js';
import { finishCommand } from './cli/finish.js';
import { handoffCommand } from './cli/handoff.js';
import { runCommand } from './cli/run.js';
import { switchCommand } from './cli/switch.js';
import { usageCommand } from './cli/usage.js';
import { agentsCommand } from './cli/agents.js';
import { historyCommand } from './cli/history.js';
import { recoverCommand } from './cli/recover.js';
import { resumeCommand } from './cli/resume.js';
import { checkpointsCommand } from './cli/checkpoints.js';
import { checkpointDiffCommand } from './cli/checkpoint-diff.js';
import { workspaceCommand } from './cli/workspace.js';
import { noteCommand } from './cli/note.js';

const program = new Command()
  .name('relay')
  .description('Durable coding-task handoffs between official agent CLIs')
  .version('0.1.0-alpha.2')
  .addCommand(initCommand())
  .addCommand(startCommand())
  .addCommand(statusCommand())
  .addCommand(checkpointCommand())
  .addCommand(checkpointsCommand())
  .addCommand(checkpointDiffCommand())
  .addCommand(noteCommand())
  .addCommand(handoffCommand())
  .addCommand(runCommand())
  .addCommand(resumeCommand())
  .addCommand(switchCommand())
  .addCommand(workspaceCommand())
  .addCommand(usageCommand())
  .addCommand(agentsCommand())
  .addCommand(historyCommand())
  .addCommand(recoverCommand())
  .addCommand(finishCommand())
  .addCommand(doctorCommand());

program.showSuggestionAfterError();
program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`relay: ${message}\n`);
  process.exitCode = 1;
});
