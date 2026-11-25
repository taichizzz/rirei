import { Command } from 'commander';
import { renderHandoffDocument, taskContext } from '../lifecycle.js';
import { parseHandoffProfile } from '../context/prompt-policy.js';

export function handoffCommand(): Command {
  return new Command('handoff')
    .description('Print a concise provider-independent task handoff')
    .option('--json', 'print the portable capsule and budget as JSON')
    .option(
      '--profile <name>',
      'experimental rendering profile: control, focused-output, stable-layout, or stable-focused',
      'control',
    )
    .action(async (options: { json?: boolean; profile: string }) => {
      const profile = parseHandoffProfile(options.profile);
      const { root, state } = await taskContext();
      const handoff = await renderHandoffDocument(
        root,
        state,
        root,
        undefined,
        { profile },
      );
      if (!options.json && handoff.policy && !handoff.policy.applied)
        process.stderr.write(
          `Handoff profile ${profile} kept control rendering: ${handoff.policy.fallbackReason}.\n`,
        );
      process.stdout.write(
        options.json ? `${JSON.stringify(handoff, null, 2)}\n` : handoff.text,
      );
    });
}
