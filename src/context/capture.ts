import { randomBytes } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CommandSpec } from '../agents/adapter.js';
import type { RelayState } from '../state/schema.js';
import { inspectGitSnapshot } from '../git/repository.js';
import { normalizeClaudeHook } from './claude.js';
import { CONTEXT_INPUT_LIMIT } from './schema.js';
import {
  appendCapturedObservation,
  contextDirectory,
  hash,
  issueCaptureGrant,
  readCaptureGrant,
  readContextPolicy,
  recordCaptureFailure,
} from './store.js';
import { readState } from '../state/store.js';

const CAPTURE_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
  'SessionEnd',
];

export async function prepareContextLaunch(options: {
  root: string;
  state: RelayState;
  runId: string;
  provider: string;
  workspace: string;
  providerSessionId?: string;
  handoffPrompt?: string;
  command: CommandSpec;
  invocation?: { executable: string; args: string[] };
}): Promise<{ command: CommandSpec; env: Record<string, string> }> {
  const empty = { command: options.command, env: {} };
  if (
    options.provider !== 'claude' ||
    !(await readContextPolicy(options.root, options.state.sessionId))?.enabled
  )
    return empty;
  const snapshot = await inspectGitSnapshot(options.workspace, 1);
  const issued = await issueCaptureGrant(options.root, {
    taskId: options.state.sessionId,
    runId: options.runId,
    workspace: await realpath(options.workspace),
    provider: 'claude',
    providerSessionId: options.providerSessionId,
    launchPromptHash: options.handoffPrompt
      ? hash(options.handoffPrompt)
      : undefined,
    launchGitFingerprint: snapshot.fingerprint,
  });
  if (!issued) return empty;
  const entry = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
  if (!options.invocation && !entry)
    throw new Error('Context capture requires a Relay CLI entry point.');
  const loaderArgs: string[] = [];
  if (entry?.endsWith('.ts')) {
    for (let index = 0; index < process.execArgv.length; index++) {
      const arg = process.execArgv[index]!;
      if (
        ['--import', '--require', '--loader'].includes(arg) &&
        process.execArgv[index + 1]?.includes('tsx')
      )
        loaderArgs.push(arg, process.execArgv[++index]!);
      else if (/^--(?:import|require|loader)=.*tsx/.test(arg))
        loaderArgs.push(arg);
    }
  }
  const invocation = options.invocation ?? {
    executable: process.execPath,
    args: [...loaderArgs, entry!, 'context', 'ingest'],
  };
  const args = [...options.command.args];
  const settingsIndex = args.indexOf('--settings');
  const existing = settingsIndex >= 0 ? args[settingsIndex + 1] : undefined;
  const settings = existing ? JSON.parse(await readFile(existing, 'utf8')) : {};
  settings.hooks ??= {};
  for (const event of CAPTURE_EVENTS) {
    settings.hooks[event] = [
      ...(settings.hooks[event] ?? []),
      {
        matcher: '',
        hooks: [
          {
            type: 'command',
            command: invocation.executable,
            args: invocation.args,
            timeout: 10,
          },
        ],
      },
    ];
  }
  const settingsFile = path.join(
    contextDirectory(options.root, options.state.sessionId),
    `claude-${hash(options.runId)}-${randomBytes(6).toString('hex')}.json`,
  );
  await writeFile(settingsFile, JSON.stringify(settings), {
    flag: 'wx',
    mode: 0o600,
  });
  if (settingsIndex >= 0)
    args.splice(settingsIndex, 2, '--settings', settingsFile);
  else args.unshift('--settings', settingsFile);
  return {
    command: { ...options.command, args },
    env: {
      RIREI_CONTEXT_ROOT: options.root,
      RIREI_CONTEXT_TASK: options.state.sessionId,
      RIREI_CONTEXT_RUN: options.runId,
      RIREI_CONTEXT_TOKEN: issued.token,
    },
  };
}

export async function ingestContextHook(
  input: NodeJS.ReadableStream,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const root = env.RIREI_CONTEXT_ROOT;
  const taskId = env.RIREI_CONTEXT_TASK;
  const runId = env.RIREI_CONTEXT_RUN;
  const token = env.RIREI_CONTEXT_TOKEN;
  if (!root || !taskId || !runId || !token)
    throw new Error('Context ingestion requires a managed capture grant.');
  try {
    const grant = await readCaptureGrant(root, taskId, runId, token);
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of input) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > CONTEXT_INPUT_LIMIT)
        throw new Error('Context hook input exceeds its limit.');
      chunks.push(buffer);
    }
    const payload = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
    );
    const state = await readState(root);
    const run = state.agentHistory.find((item) => item.id === runId);
    const lease = state.runs.find((item) => item.runId === runId);
    if (
      state.sessionId !== taskId ||
      !run ||
      run.agent !== 'claude' ||
      run.endedAt ||
      !lease ||
      lease.status === 'orphaned'
    )
      throw new Error('Context capture run is no longer active.');
    if (typeof payload?.cwd !== 'string')
      throw new Error('Context hook has no workspace.');
    normalizeClaudeHook(payload, grant);
    payload.cwd = await realpath(payload.cwd);
    const observation = normalizeClaudeHook(payload, grant);
    await appendCapturedObservation(root, taskId, runId, token, observation);
  } catch {
    await recordCaptureFailure(root, taskId, runId, token).catch(
      () => undefined,
    );
    throw new Error(
      'Context capture failed. Retained history may be incomplete; inspect relay context status.',
    );
  }
}
