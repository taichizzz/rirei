import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  readFile,
  realpath,
  rename,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  initializeProject,
  startTask,
} from '../../src/application/project-setup.js';
import { verifySwitchPreview } from '../../src/cli/switch.js';
import { readConfig, writeConfig } from '../../src/config/loader.js';
import {
  buildInspectionDocument,
  inspectCurrentContext,
} from '../../src/context/inspection.js';
import type { InspectionExcerpt } from '../../src/context/inspection-schema.js';
import { loadContinuitySources } from '../../src/context/render.js';
import { inspectCoveredSnapshot } from '../../src/context/snapshot.js';
import {
  appendCapturedObservation,
  issueCaptureGrant,
  setContextConsent,
} from '../../src/context/store.js';
import {
  beginVerification,
  completeVerification,
} from '../../src/context/verification.js';
import { renderHandoffDocument } from '../../src/lifecycle.js';
import { addHandoffNote } from '../../src/state/notes.js';
import { readState, updateState } from '../../src/state/store.js';
import { WORKFLOWS } from '../../benchmarks/continuity/workflows.mjs';
import { createRepository, removeRepository } from '../helpers.js';

const execute = promisify(execFile);
const roots: string[] = [];
const limits = { timeoutMs: 10000 };
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeRepository));
});
async function project() {
  const root = await realpath(await createRepository());
  roots.push(root);
  await initializeProject(root);
  const state = await startTask(
    root,
    'Fix the behavior while preserving the public API.',
  );
  return { root, state };
}
async function capture(
  root: string,
  taskId: string,
  provider: 'claude' | 'codex' = 'claude',
) {
  await setContextConsent(root, taskId, true);
  const issued = (await issueCaptureGrant(root, {
    taskId,
    provider,
    runId: 'inspection-fixture',
    workspace: root,
    providerSessionId: 'fixture-session',
    launchGitFingerprint: 'historical',
  }))!;
  return (text: string, extra: Record<string, unknown> = {}) =>
    appendCapturedObservation(
      root,
      taskId,
      'inspection-fixture',
      issued.token,
      {
        provider,
        providerSessionId: 'fixture-session',
        hook: 'fixture',
        kind: 'prompt_submission',
        text,
        redacted: false,
        truncated: false,
        ...extra,
      },
    );
}
const inspect = (root: string, options = {}) =>
  inspectCurrentContext(root, root, { snapshotLimits: limits, ...options });
const excerpts = (items: Array<{ kind: string }>) =>
  items.filter(
    (item) => item.kind === 'diff' || item.kind === 'current-file',
  ) as InspectionExcerpt[];

describe('bounded current-state inspection', () => {
  it('keeps a small envelope truthful with source gaps, partial files, omitted actions and a long workspace', async () => {
    const { root, state } = await project();
    const record = await capture(root, state.sessionId);
    await record('Truncated source '.repeat(500), { truncated: true });
    await updateState(root, (current) => ({
      ...current,
      blockers: [
        {
          description: 'Blocker '.repeat(200),
          createdAt: current.task.createdAt,
        },
      ],
      tests: [
        {
          command: 'long-command '.repeat(200),
          status: 'failed',
          exitCode: 1,
          durationMs: 1,
          createdAt: current.task.createdAt,
        },
      ],
    }));
    const snapshot = await inspectCoveredSnapshot(
      root,
      { ...limits, maxFileBytes: 2 },
      { inspection: { includeText: true } },
    );
    const sources = await loadContinuitySources(root, state.sessionId, root);
    for (const format of ['text', 'json'] as const) {
      const result = await buildInspectionDocument(
        await readState(root),
        { ...snapshot, workspace: '/long/' + 'x'.repeat(3000) },
        sources,
        null,
        { format, maxCharacters: 1200 },
      );
      expect(result.output.length).toBeLessThanOrEqual(1200);
      expect(result.packet.workspace).toBeNull();
      expect(result.packet.requirements.status).toBe('source-incomplete');
      expect(result.output).toContain('REQUIRED BEFORE EDITING');
      expect(result.output).toContain('clarify missing requirements');
    }
  });

  it('returns separate bounded changed hunks without duplicating cited current-file windows', async () => {
    const { root, state } = await project();
    const original = Array.from(
      { length: 24 },
      (_, index) => `original line ${index}`,
    );
    await writeFile(path.join(root, 'README.md'), original.join('\n'));
    await execute('git', ['add', 'README.md'], { cwd: root });
    await execute('git', ['commit', '-m', 'Fixture line baseline'], {
      cwd: root,
    });
    const changed = [...original];
    changed[2] = 'first changed line';
    changed[20] = 'second changed line';
    await writeFile(path.join(root, 'README.md'), changed.join('\n'));
    const record = await capture(root, state.sessionId);
    await record('read', { kind: 'tool_result', filePath: 'README.md' });
    const result = await inspect(root, {
      format: 'json',
      maxCharacters: 12000,
    });
    const windows = excerpts(result.packet.items);
    expect(windows).toHaveLength(2);
    expect(
      windows.every((item) => item.kind === 'diff' && !item.truncated),
    ).toBe(true);
    expect(windows[0]?.text).toContain('+first changed line');
    expect(windows[1]?.text).toContain('+second changed line');
    expect(windows[0]!.endLine).toBeLessThan(windows[1]!.startLine);
  });

  it('answers requirements, changed code, observed verification and recorded next actions in one read-only packet', async () => {
    const { root, state } = await project();
    await writeFile(path.join(root, 'README.md'), '# Fixed behavior\n');
    await writeFile(
      path.join(root, 'feature.mjs'),
      'export const count = 2;\n',
    );
    const record = await capture(root, state.sessionId);
    await record('Correction: keep the output order and add no dependencies.');
    const note = await addHandoffNote(root, state, {
      type: 'next',
      text: 'Review the boundary case.',
      source: 'user',
    });
    const config = await readConfig(root);
    await writeConfig(root, {
      ...config,
      tests: { ...config.tests, command: 'npm test' },
    });
    const pending = await beginVerification(root, state.sessionId, 'npm test', {
      snapshotLimits: limits,
    });
    await completeVerification(root, pending, 1, 5, { snapshotLimits: limits });
    const stateBefore = await readFile(
      path.join(root, '.relay/state.json'),
      'utf8',
    );
    const indexBefore = await readFile(path.join(root, '.git/index'));
    const result = await inspect(root, { format: 'json' });
    expect(JSON.parse(result.output)).toEqual(result.packet);
    expect(result.output.length).toBeLessThanOrEqual(6000);
    expect(result.packet.budget.usedCharacters).toBe(result.output.length);
    expect(result.packet.requirements.status).toBe('retained-text-inline');
    expect(result.output).toContain('keep the output order');
    expect(result.packet.changes).toEqual({ observed: 2, complete: true });
    expect(result.packet.items).toContainEqual(
      expect.objectContaining({
        kind: 'verification',
        outcome: 'failed',
        freshness: 'current-observation',
      }),
    );
    expect(result.packet.items).toContainEqual(
      expect.objectContaining({
        kind: 'action',
        source: note.id,
        provenance: 'user',
        text: 'Review the boundary case.',
      }),
    );
    expect(excerpts(result.packet.items).map((item) => item.path)).toContain(
      'feature.mjs',
    );
    expect(result.output).toContain('export const count = 2;');
    expect(await readFile(path.join(root, '.relay/state.json'), 'utf8')).toBe(
      stateBefore,
    );
    expect(await readFile(path.join(root, '.git/index'))).toEqual(indexBefore);
  });

  it('preserves the M2 fingerprint while retaining source bytes from the same stable scans', async () => {
    const { root } = await project();
    const file = path.join(root, 'README.md');
    const old = await inspectCoveredSnapshot(root, limits);
    const captured = await inspectCoveredSnapshot(root, limits, {
      inspection: { includeText: true, referencedPaths: ['README.md'] },
    });
    expect(captured.identity).toEqual(old.identity);
    expect(captured.inspection?.[0]?.text).toBe('# Test\n');
    const retried = await inspectCoveredSnapshot(root, limits, {
      inspection: { includeText: true },
      afterScan: async (attempt) => {
        if (attempt === 1) await writeFile(file, '# Changed once\n');
      },
    });
    expect(retried.attempts).toBe(3);
    expect(retried.identity.coverage.status).toBe('complete');
    expect(retried.inspection?.[0]?.text).toBe('# Changed once\n');
    expect(retried.identity.id).toBe(
      (await inspectCoveredSnapshot(root, limits)).identity.id,
    );
  });

  it('shows staged and worktree cancellation separately with the right source identities', async () => {
    const { root } = await project();
    await writeFile(path.join(root, 'README.md'), '# Staged version\n');
    await execute('git', ['add', 'README.md'], { cwd: root });
    await writeFile(path.join(root, 'README.md'), '# Test\n');
    const result = await inspect(root, { format: 'json' });
    expect(result.packet.items).toContainEqual(
      expect.objectContaining({
        kind: 'file-change',
        path: 'README.md',
        staged: 'modified',
        worktree: 'modified',
      }),
    );
    const code = excerpts(result.packet.items);
    expect(code.find((item) => item.layer === 'staged')?.text).toContain(
      '+# Staged version',
    );
    expect(code.find((item) => item.layer === 'staged')).toHaveProperty(
      'resultOid',
    );
    expect(code.find((item) => item.layer === 'staged')).not.toHaveProperty(
      'contentHash',
    );
    expect(code.find((item) => item.layer === 'worktree')?.text).toContain(
      '+# Test',
    );
    expect(code.find((item) => item.layer === 'worktree')?.contentHash).toBe(
      createHash('sha256').update('# Test\n').digest('hex'),
    );
  });

  it('shows deletion and added rename destinations without guessing semantic intent', async () => {
    const { root } = await project();
    await rename(
      path.join(root, 'README.md'),
      path.join(root, 'renamed 日本語.md'),
    );
    const result = await inspect(root, { format: 'json' });
    expect(result.packet.items).toContainEqual(
      expect.objectContaining({ path: 'README.md', worktree: 'deleted' }),
    );
    expect(result.packet.items).toContainEqual(
      expect.objectContaining({
        path: 'renamed 日本語.md',
        worktree: 'untracked',
      }),
    );
    expect(
      excerpts(result.packet.items).some((item) =>
        item.text.includes('-# Test'),
      ),
    ).toBe(true);
    expect(
      excerpts(result.packet.items).some((item) =>
        item.text.includes('+# Test'),
      ),
    ).toBe(true);
    expect(
      result.packet.items.filter((item) => item.kind === 'action'),
    ).toEqual([]);
    const missing = await inspect(root, {
      file: 'missing.mjs',
      format: 'json',
    });
    expect(missing.packet.items).toContainEqual(
      expect.objectContaining({
        path: 'missing.mjs',
        omission: 'path-not-in-covered-manifest',
      }),
    );
  });

  it('deduplicates direct file references and never treats historical paths as read authority', async () => {
    const { root, state } = await project();
    const record = await capture(root, state.sessionId);
    await record('read', { kind: 'tool_result', filePath: 'README.md' });
    await record('read again', { kind: 'tool_result', filePath: 'README.md' });
    await record('missing reference', {
      kind: 'tool_result',
      filePath: 'missing-reference.mjs',
    });
    await record('old path', {
      kind: 'tool_result',
      filePath: '/previous/worktree/secret',
      command: 'cat /previous/worktree/secret',
    });
    await record('outside', { kind: 'tool_result', filePath: '../secret' });
    const result = await inspect(root, { format: 'json' });
    expect(excerpts(result.packet.items)).toHaveLength(1);
    expect(result.packet.items).toContainEqual(
      expect.objectContaining({
        path: 'missing-reference.mjs',
        source: 'reported-reference',
        omission: 'path-not-in-covered-manifest',
      }),
    );
    expect(excerpts(result.packet.items)[0]).toMatchObject({
      kind: 'current-file',
      path: 'README.md',
      startLine: 1,
      text: '# Test\n',
    });
    expect(result.output).not.toContain('/previous/worktree');
    expect(result.output).not.toContain('../secret');
  });

  it('discloses binary, large-source and display-diff omissions within a bounded response', async () => {
    const { root } = await project();
    await writeFile(path.join(root, 'binary.dat'), Buffer.from([0, 1, 2, 3]));
    await writeFile(path.join(root, 'large.txt'), 'long line\n'.repeat(10000));
    await writeFile(path.join(root, 'many-lines.txt'), 'line\n'.repeat(500));
    const result = await inspect(root, { format: 'json' });
    expect(result.packet.items).toContainEqual(
      expect.objectContaining({
        path: 'binary.dat',
        omission: 'binary-or-invalid-utf8',
      }),
    );
    expect(result.packet.items).toContainEqual(
      expect.objectContaining({
        path: 'large.txt',
        omission: 'source-size-limit',
      }),
    );
    expect(result.packet.items).toContainEqual(
      expect.objectContaining({
        path: 'many-lines.txt',
        omission: 'diff-display-truncated',
      }),
    );
    expect(result.packet.next.join(' ')).toContain('--file <relative-path>');
    expect(result.output.length).toBeLessThanOrEqual(6000);
  });

  it('redacts recognized secrets in excerpts without replacing their raw snapshot identity', async () => {
    const { root } = await project();
    const secret = `sk-ant-${'x'.repeat(40)}`;
    await writeFile(
      path.join(root, 'config.mjs'),
      `export const credential = '${secret}';\n`,
    );
    const result = await inspect(root, { format: 'json' });
    expect(result.output).not.toContain(secret);
    expect(excerpts(result.packet.items)[0]?.redacted).toBe(true);
    expect(excerpts(result.packet.items)[0]?.contentHash).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });

  it.each([1200, 1800, 2400, 6000, 12000])(
    'enforces the entire text and JSON envelope at %i characters without splitting requirements',
    async (maximum) => {
      const { root, state } = await project();
      const record = await capture(root, state.sessionId);
      await record('😀 "quoted" \\ \n'.repeat(1000));
      await record(
        'Correction: preserve every duplicate, including case-sensitive IDs.',
      );
      await writeFile(path.join(root, 'README.md'), '# Changed\n');
      for (const format of ['text', 'json'] as const) {
        const result = await inspect(root, { format, maxCharacters: maximum });
        expect(result.output.length).toBeLessThanOrEqual(maximum);
        expect(result.output.isWellFormed()).toBe(true);
        expect(result.packet.budget.usedCharacters).toBe(result.output.length);
        expect(result.packet.requirements.status).toBe('lookup-required');
        expect(result.output).toContain('REQUIRED BEFORE EDITING');
        if (maximum >= 1800)
          expect(result.output).toContain('preserve every duplicate');
        if (format === 'json')
          expect(JSON.parse(result.output)).toEqual(result.packet);
        for (const item of result.packet.items.filter(
          (item) => item.kind === 'requirement',
        ))
          expect(item.text.length).toBe(item.end);
      }
    },
  );

  it.each(
    WORKFLOWS.flatMap((task) =>
      ['claude', 'codex'].map((provider) => ({ task, provider })),
    ),
  )(
    'preserves all $task.id requirements with a $provider history before optional source context',
    async ({ task, provider }) => {
      const { root, state } = await project();
      const record = await capture(
        root,
        state.sessionId,
        provider as 'claude' | 'codex',
      );
      const submitted = [
        task.request,
        ...task.requirements,
        `Implement ${task.firstStage} first; keep tests unchanged.`,
      ].join('\n\n');
      await record(submitted);
      for (let index = 0; index < 8; index++)
        await record('tool noise '.repeat(1000), {
          kind: 'tool_result',
          filePath: 'README.md',
        });
      const result = await inspect(root, { format: 'json' });
      for (const requirement of task.requirements)
        expect(result.output).toContain(
          JSON.stringify(requirement).slice(1, -1),
        );
      expect(result.packet.requirements.status).toBe('retained-text-inline');
      expect(
        result.packet.items.filter((item) => item.kind === 'action'),
      ).toEqual([]);
      const handoff = await renderHandoffDocument(root, await readState(root));
      for (const requirement of task.requirements)
        expect(handoff.text).toContain(requirement);
      expect(handoff.continuity?.submissionCoverage?.requiredSourceIds).toEqual(
        [],
      );
      expect(handoff.continuity!.text.length).toBeLessThanOrEqual(6000);
      expect(handoff.inspection?.snapshotId).toBe(result.packet.snapshot.id);
      expect(handoff.text).not.toContain('Display diff');
    },
  );

  it('keeps truncated captured requirements incomplete even if all retained text fits', async () => {
    const { root, state } = await project();
    const record = await capture(root, state.sessionId);
    await record('Only the retained part', { truncated: true });
    const result = await inspect(root);
    expect(result.packet.requirements).toMatchObject({
      status: 'source-incomplete',
      sourceGaps: 1,
    });
    expect(result.output).toContain('clarify missing requirements');
  });

  it('falls back to metadata when the snapshot is limited and rejects an incomplete expected identity', async () => {
    const { root } = await project();
    await writeFile(path.join(root, 'README.md'), '# More than two bytes\n');
    const result = await inspect(root, {
      format: 'json',
      snapshotLimits: { ...limits, maxFileBytes: 2 },
    });
    expect(result.packet.snapshot.status).toBe('partial');
    expect(excerpts(result.packet.items)).toEqual([]);
    expect(result.packet.changes.complete).toBe(false);
    expect(result.packet.gaps).toContain(
      'metadata-only: covered inputs incomplete',
    );
    await expect(
      inspect(root, {
        snapshot: result.packet.snapshot.id,
        snapshotLimits: { ...limits, maxFileBytes: 2 },
      }),
    ).rejects.toThrow('stale or incompletely covered');
  });

  it.skipIf(process.platform === 'win32')(
    'keeps symlink targets and sensitive tracked files out of code capture',
    async () => {
      const { root } = await project();
      const other = await project();
      await writeFile(
        path.join(other.root, 'secret'),
        'OUTSIDE_WORKSPACE_SENTINEL',
      );
      await symlink(path.join(other.root, 'secret'), path.join(root, 'link'));
      let result = await inspect(root, { format: 'json' });
      expect(result.packet.snapshot.status).toBe('partial');
      expect(excerpts(result.packet.items)).toEqual([]);
      expect(result.output).not.toContain('OUTSIDE_WORKSPACE_SENTINEL');
      await unlink(path.join(root, 'link'));
      await writeFile(path.join(root, '.env'), 'SENSITIVE_SENTINEL');
      await execute('git', ['add', '-f', '.env'], { cwd: root });
      result = await inspect(root, { format: 'json' });
      expect(result.packet.snapshot.status).toBe('partial');
      expect(result.output).not.toContain('SENSITIVE_SENTINEL');
    },
  );

  it('invalidates derived packets for code, task, evidence and consent changes, keeping storage-only revisions stable', async () => {
    const { root, state } = await project();
    const record = await capture(root, state.sessionId);
    await record('Keep ordering.');
    await writeFile(path.join(root, 'new.mjs'), 'one');
    const first = await inspect(root, { format: 'json' });
    await updateState(root, (value) => value);
    expect((await inspect(root, { format: 'json' })).output).toBe(first.output);
    await record('Correction: preserve duplicates too.');
    const evidence = await inspect(root, { format: 'json' });
    expect(evidence.packet.packetId).not.toBe(first.packet.packetId);
    await updateState(root, (current) => ({
      ...current,
      task: { ...current.task, constraints: ['No dependencies'] },
    }));
    const task = await inspect(root, { format: 'json' });
    expect(task.packet.packetId).not.toBe(evidence.packet.packetId);
    await writeFile(path.join(root, 'new.mjs'), 'two');
    await expect(
      inspect(root, { snapshot: task.packet.snapshot.id }),
    ).rejects.toThrow('stale');
    const changed = await inspect(root, { format: 'json' });
    expect(changed.packet.snapshot.id).not.toBe(task.packet.snapshot.id);
    const preview = await renderHandoffDocument(root, await readState(root));
    await expect(verifySwitchPreview(root, preview)).resolves.toHaveProperty(
      'sessionId',
      state.sessionId,
    );
    await writeFile(path.join(root, 'new.mjs'), 'three');
    await expect(verifySwitchPreview(root, preview)).rejects.toThrow(
      'Handoff-relevant',
    );
    await setContextConsent(root, state.sessionId, false);
    const disabled = await inspect(root, { format: 'json' });
    expect(disabled.packet.requirements.capture).toBe('disabled');
    expect(disabled.output).not.toContain('preserve duplicates too');
  });

  it('rejects escaping paths and invalid ceilings before generating an inspection', async () => {
    const { root } = await project();
    for (const file of [
      '../outside',
      '/absolute',
      'C:\\outside',
      '\\\\server\\share',
      '.relay/state.json',
      'nested/../source',
      '~/.env',
    ])
      await expect(inspect(root, { file })).rejects.toThrow(
        'workspace-relative',
      );
    for (const maxCharacters of [1199, 12001, 2.5, NaN])
      await expect(inspect(root, { maxCharacters })).rejects.toThrow('budget');
    await expect(inspect(root, { snapshot: 'not-a-digest' })).rejects.toThrow(
      'Invalid covered snapshot',
    );
  });

  it('reuses a supplied snapshot for all inspection and verification content', async () => {
    const { root, state } = await project();
    await writeFile(path.join(root, 'README.md'), '# First observed version\n');
    const snapshot = await inspectCoveredSnapshot(root, limits, {
      inspection: { includeText: true },
    });
    await writeFile(path.join(root, 'README.md'), '# Later live version\n');
    const sources = await loadContinuitySources(root, state.sessionId, root);
    const document = await buildInspectionDocument(
      state,
      snapshot,
      sources,
      null,
      { format: 'json' },
    );
    expect(document.packet.snapshot.id).toBe(snapshot.identity.id);
    expect(document.output).toContain('First observed version');
    expect(document.output).not.toContain('Later live version');
    await expect(
      inspect(root, { snapshot: snapshot.identity.id }),
    ).rejects.toThrow('stale');
  });
});
