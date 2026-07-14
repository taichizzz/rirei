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

const program = new Command()
  .name('relay')
  .description('Durable coding-task handoffs between official agent CLIs')
  .version('0.1.0')
  .addCommand(initCommand())
  .addCommand(startCommand())
  .addCommand(statusCommand())
  .addCommand(checkpointCommand())
  .addCommand(handoffCommand())
  .addCommand(runCommand())
  .addCommand(switchCommand())
  .addCommand(usageCommand())
  .addCommand(agentsCommand())
  .addCommand(finishCommand())
  .addCommand(doctorCommand());

program.showSuggestionAfterError();
program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`relay: ${message}\n`);
  process.exitCode = 1;
});
