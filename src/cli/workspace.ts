import { Command } from 'commander';
import { discoverRepository } from '../git/repository.js';
import { taskContext } from '../lifecycle.js';
import {
  createWorkspace,
  inspectWorkspaceCleanup,
} from '../worktrees/manager.js';
import { readRegistry } from '../worktrees/registry.js';
import { workspaceRoleSchema } from '../worktrees/schema.js';

async function requireRoot(): Promise<string> {
  const projectRoot = await discoverRepository(process.cwd());
  if (!projectRoot)
    throw new Error('Relay must be run inside a Git repository.');
  return projectRoot;
}

function parseRole(value: string) {
  const parsed = workspaceRoleSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(
      `Unknown role: ${value}. Use implement, review, verify, or investigate.`,
    );
  return parsed.data;
}

function createSubcommand(): Command {
  return new Command('create')
    .description(
      'Create an isolated Git worktree workspace for the current task',
    )
    .option(
      '--role <role>',
      'implement, review, verify, or investigate',
      'implement',
    )
    .option(
      '--slug <slug>',
      'override the branch slug (defaults to task title)',
    )
    .option('--operation-id <id>', 'idempotency key for workspace creation')
    .option('--json', 'print machine-readable JSON')
    .action(
      async (options: {
        role: string;
        slug?: string;
        operationId?: string;
        json?: boolean;
      }) => {
        const root = await requireRoot();
        const role = parseRole(options.role);
        const { state } = await taskContext();
        const { workspace, preview } = await createWorkspace(root, {
          role,
          parentTaskId: state.sessionId,
          slug: options.slug ?? state.task.title,
          operationId: options.operationId,
        });
        if (options.json) {
          process.stdout.write(`${JSON.stringify(workspace, null, 2)}\n`);
          return;
        }
        process.stdout.write(
          [
            `Created workspace ${workspace.id}`,
            `  role:     ${workspace.role}`,
            `  branch:   ${workspace.branch}`,
            `  worktree: ${workspace.worktreePath}`,
            `  base:     ${preview.baseBranch} at ${workspace.baseCommit}`,
            '',
            'The main working tree was not modified. Relay never merges, resets,',
            'force-deletes, rebases, or pushes this branch.',
            '',
          ].join('\n'),
        );
      },
    );
}

function listSubcommand(): Command {
  return new Command('list')
    .description('List Rirei workspaces registered for this repository')
    .option('--json', 'print machine-readable JSON')
    .action(async (options: { json?: boolean }) => {
      const root = await requireRoot();
      const registry = await readRegistry(root);
      if (options.json) {
        process.stdout.write(
          `${JSON.stringify(registry.workspaces, null, 2)}\n`,
        );
        return;
      }
      if (registry.workspaces.length === 0) {
        process.stdout.write('No workspaces registered.\n');
        return;
      }
      const lines = registry.workspaces.map(
        (workspace) =>
          `${workspace.id}  ${workspace.status.padEnd(18)} ${workspace.role.padEnd(12)} ${workspace.branch}`,
      );
      process.stdout.write(`${lines.join('\n')}\n`);
    });
}

function cleanupSubcommand(): Command {
  return new Command('cleanup')
    .description(
      'Inspect a workspace and print copyable manual cleanup commands (removes nothing)',
    )
    .argument('<workspaceId>', 'the workspace ID to inspect')
    .option('--json', 'print machine-readable JSON')
    .action(async (workspaceId: string, options: { json?: boolean }) => {
      const root = await requireRoot();
      const inspection = await inspectWorkspaceCleanup(root, workspaceId);
      if (options.json) {
        process.stdout.write(`${JSON.stringify(inspection, null, 2)}\n`);
        return;
      }
      const lines = [
        `Workspace ${inspection.workspace.id} (${inspection.workspace.branch})`,
        `  worktree exists: ${inspection.worktreeExists ? 'yes' : 'no'}`,
        `  active run:      ${inspection.activeRunId ?? 'none'}`,
        `  dirty:           ${inspection.dirty ? `yes (${inspection.changedFiles} file(s))` : 'no'}`,
        `  commits ahead:   ${inspection.commitsAhead ?? 'unknown'}`,
        `  unpushed:        ${
          inspection.hasUpstream
            ? (inspection.unpushedCommits ?? 'unknown')
            : 'no upstream'
        }`,
        '',
        inspection.cleanupSafe
          ? 'Cleanup looks safe. Relay will not run these for you; copy them if you are sure:'
          : 'Cleanup is BLOCKED — running removal now would lose work:',
      ];
      if (!inspection.cleanupSafe)
        for (const reason of inspection.reasons) lines.push(`  - ${reason}`);
      lines.push(
        '',
        ...inspection.commands.map((command) => `  ${command}`),
        '',
      );
      process.stdout.write(`${lines.join('\n')}\n`);
    });
}

export function workspaceCommand(): Command {
  return new Command('workspace')
    .description('Manage isolated Git worktree workspaces (Rirei)')
    .addCommand(createSubcommand())
    .addCommand(listSubcommand())
    .addCommand(cleanupSubcommand());
}
