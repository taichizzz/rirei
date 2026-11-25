import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  initializeProject,
  startTask,
} from '../../src/application/project-setup.js';
import { normalizeClaudeHook } from '../../src/context/claude.js';
import {
  inspectContextEvents,
  loadContinuityContext,
} from '../../src/context/render.js';
import {
  appendCapturedObservation,
  issueCaptureGrant,
  readContextJournal,
  setContextConsent,
} from '../../src/context/store.js';
import { createRepository, removeRepository } from '../helpers.js';

interface Fixture {
  id: string;
  request: string;
  events: Record<string, unknown>[];
  mustRetain: string[];
  pendingTools: number;
}
const fixtures: Fixture[] = JSON.parse(
  await readFile(
    new URL('../../benchmarks/continuity/fixtures.json', import.meta.url),
    'utf8',
  ),
);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeRepository));
});

describe('frozen interruption histories', () => {
  it.each(fixtures)(
    'replays $id without a predecessor summary or a model call',
    async (fixture) => {
      const root = await realpath(await createRepository());
      roots.push(root);
      await initializeProject(root);
      const state = await startTask(root, fixture.request);
      await setContextConsent(root, state.sessionId, true);
      const issued = (await issueCaptureGrant(root, {
        taskId: state.sessionId,
        runId: 'fixture-run',
        workspace: root,
        providerSessionId: 'fixture-session',
        launchGitFingerprint: 'frozen',
      }))!;
      for (const payload of fixture.events) {
        await appendCapturedObservation(
          root,
          state.sessionId,
          'fixture-run',
          issued.token,
          normalizeClaudeHook(
            { session_id: 'fixture-session', cwd: root, ...payload },
            issued.grant,
          ),
        );
      }
      const journal = await readContextJournal(root, state.sessionId);
      const view = (await loadContinuityContext(
        root,
        state.sessionId,
        root,
        'frozen',
      ))!;
      for (const expected of fixture.mustRetain)
        expect(view.text).toContain(expected);
      expect(journal.events).toHaveLength(fixture.events.length);
      expect(inspectContextEvents(journal.events).pendingTools).toHaveLength(
        fixture.pendingTools,
      );
      for (const event of journal.events.filter((item) =>
        ['prompt_submission', 'tool_result', 'assistant_claim'].includes(
          item.kind,
        ),
      ))
        expect(view.text).toContain(event.id);
      if (fixture.id === 'unverified-edit') {
        expect(view.text).toContain('UNVERIFIED ASSISTANT CLAIM');
        expect(
          journal.events.filter(
            (event) => event.kind === 'tool_result' && event.command,
          ),
        ).toMatchObject([{ outcome: 'reported_failure', exitCode: null }]);
      }
      if (fixture.id === 'abrupt-interruption')
        expect(view.text).toContain('Outcome unknown');
    },
  );

  it('checks every frozen reference and interrupted snapshot with hidden acceptance tests', async () => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [path.resolve('benchmarks/continuity/check.mjs')],
      { cwd: process.cwd() },
    );
    const report = JSON.parse(stdout);
    expect(report).toMatchObject({
      mode: 'offline-fixture-validation',
      providerCalls: 0,
    });
    expect(report.results).toHaveLength(6);
    for (const result of report.results) {
      expect(result).toMatchObject({
        referencePassed: true,
        interruptedRejected: true,
      });
      expect(result.inputHash).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});
