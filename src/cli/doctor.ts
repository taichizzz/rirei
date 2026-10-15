import { access, constants, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { detectExecutable, registeredAgents } from '../agents/registry.js';
import { readStoredClaudeSample } from '../agents/usage-collectors.js';
import { discoverRepository } from '../git/repository.js';
import { relayPath } from '../safety/path-policy.js';
import { resolveCcusageBinary } from '../token-usage/resolve.js';
import { inspectInstallation } from '../platform/installation.js';

function toTildePath(fullPath: string): string {
  const home = homedir();
  if (fullPath === home) return '~';
  if (fullPath.startsWith(home + path.sep) || fullPath.startsWith(home + '/')) {
    return `~${fullPath.slice(home.length)}`;
  }
  return fullPath;
}

async function inspectDir(
  dirPath: string,
): Promise<{ status: 'found' | 'empty' | 'missing'; tildePath: string }> {
  const tildePath = toTildePath(dirPath);
  try {
    const entries = await readdir(dirPath);
    return {
      status: entries.length > 0 ? 'found' : 'empty',
      tildePath,
    };
  } catch {
    return {
      status: 'missing',
      tildePath,
    };
  }
}

async function countCodexRollouts(dirPath: string): Promise<number> {
  try {
    let count = 0;
    const pending = [dirPath];
    while (pending.length > 0) {
      const current = pending.pop()!;
      try {
        const entries = await readdir(current, { withFileTypes: true });
        for (const entry of entries) {
          const full = path.join(current, entry.name);
          if (entry.isDirectory()) {
            pending.push(full);
          } else if (/^rollout-.*\.jsonl$/.test(entry.name)) {
            count += 1;
          }
        }
      } catch {
        // Skip unreadable directory
      }
    }
    return count;
  } catch {
    return 0;
  }
}

export function doctorCommand(): Command {
  return new Command('doctor')
    .description('Inspect local Relay prerequisites')
    .option(
      '--installation',
      'check the installed package without agent or project scans',
    )
    .option(
      '--json',
      'print installation diagnostics as JSON (requires --installation)',
    )
    .action(async (options: { installation?: boolean; json?: boolean }) => {
      if (options.json && !options.installation)
        throw new Error(
          'Use relay doctor --installation --json for package diagnostics.',
        );
      if (options.installation) {
        const result = await inspectInstallation();
        process.stdout.write(
          options.json
            ? `${JSON.stringify(result)}\n`
            : [
                `Rirei ${result.version} (${result.platform}-${result.arch})`,
                `Node.js ${result.node.version}: ${result.node.status}`,
                `Git: ${result.git.status}`,
                `${result.terminal.backend}: ${result.terminal.status}`,
                `ccusage ${result.tokenCollector.version ?? 'missing'}: ${result.tokenCollector.status}`,
                result.next,
                '',
              ].join('\n'),
        );
        if (!result.ok) process.exitCode = 1;
        return;
      }
      const projectRoot = await discoverRepository(process.cwd());
      const git = projectRoot ? 'ready' : 'error (not in a repository)';
      let relay = 'not initialized';
      if (projectRoot) {
        try {
          await access(relayPath(projectRoot), constants.W_OK);
          relay = 'writable';
        } catch {
          relay = 'not writable or not initialized';
        }
      }
      process.stdout.write(
        `Git: ${git}\nNode.js: ${process.version}\nRelay: ${relay}\n\n`,
      );
      process.stdout.write(
        'Agent   Installed        Authentication  Interactive  Headless\n',
      );
      for (const agent of registeredAgents()) {
        const installation = await detectExecutable(agent.executable);
        const installed = installation.status === 'ready';
        const authentication = installed
          ? await agent.detectAuthentication()
          : undefined;
        process.stdout.write(
          `${agent.displayName.padEnd(8)}${(installed ? 'Yes' : 'No').padEnd(17)}${(installed
            ? (authentication?.status ?? 'unavailable')
            : 'unavailable'
          ).padEnd(
            16,
          )}${(agent.capabilities.interactive ? 'Yes' : 'No').padEnd(12)}${
            agent.capabilities.headless ? 'Yes' : 'No'
          }\n`,
        );
      }

      // Usage sources health check
      process.stdout.write('\nUsage sources:\n');
      const ccusageResolved = resolveCcusageBinary();
      if (ccusageResolved) {
        process.stdout.write(
          `ccusage:        Ready (${ccusageResolved.version}, ${ccusageResolved.pathClass})\n`,
        );
      } else {
        process.stdout.write(
          `ccusage:        Missing (not resolved for platform ${process.platform}-${process.arch})\n`,
        );
      }

      const home = homedir();
      const codexHome = process.env.CODEX_HOME || path.join(home, '.codex');
      const openCodeDataDir =
        process.platform === 'darwin'
          ? path.join(home, 'Library', 'Application Support', 'opencode')
          : path.join(home, '.local', 'share', 'opencode');

      const agentDirs: Array<{ name: string; path: string }> = [
        { name: 'Claude', path: path.join(home, '.claude') },
        { name: 'Codex', path: codexHome },
        { name: 'Gemini', path: path.join(home, '.gemini') },
        {
          name: 'Antigravity',
          path: path.join(home, '.gemini', 'antigravity-cli'),
        },
        { name: 'OpenCode', path: openCodeDataDir },
      ];

      process.stdout.write('\nAgent data directories:\n');
      for (const ad of agentDirs) {
        const res = await inspectDir(ad.path);
        process.stdout.write(
          `${ad.name.padEnd(15)} ${res.status.padEnd(8)} (${res.tildePath})\n`,
        );
      }

      // Codex sessions vs archived_sessions
      const activeCodex = await countCodexRollouts(
        path.join(codexHome, 'sessions'),
      );
      const archivedCodex = await countCodexRollouts(
        path.join(codexHome, 'archived_sessions'),
      );
      process.stdout.write('\nCodex session telemetry:\n');
      process.stdout.write(
        `Rollouts:       ${activeCodex} in ${toTildePath(path.join(codexHome, 'sessions'))}, ${archivedCodex} in ${toTildePath(path.join(codexHome, 'archived_sessions'))}\n`,
      );

      // Claude rate limits status
      const claudeSample = await readStoredClaudeSample({
        projectRoot: projectRoot ?? process.cwd(),
      });
      const hasRateLimits =
        claudeSample &&
        (claudeSample.fiveHour || claudeSample.week || claudeSample.windows) &&
        claudeSample.status !== 'error';
      const claudeRateLimitsText = hasRateLimits
        ? 'Reported'
        : 'Not reported (upstream anthropics/claude-code #40094)';
      process.stdout.write('\nClaude rate limits:\n');
      process.stdout.write(`Status line:    ${claudeRateLimitsText}\n`);
    });
}
