import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderEvidenceBriefing } from '../../src/context/briefing.js';
import { WORKFLOWS } from '../../benchmarks/continuity/workflows.mjs';
import {
  contextEventSchema,
  type ContextEvent,
} from '../../src/context/schema.js';
import {
  ARMS,
  codexArguments,
  compare,
  summarize,
} from '../../benchmarks/continuity/compare.mjs';

function event(sequence: number, value: Partial<ContextEvent>): ContextEvent {
  return contextEventSchema.parse({
    schemaVersion: 1,
    id: `e-${sequence.toString(16).padStart(32, '0')}`,
    sequence,
    receivedAt: '2020-01-01T00:00:00.000Z',
    taskId: 'task',
    runId: 'run',
    provider: 'claude',
    providerSessionId: 'session',
    workspace: '0'.repeat(64),
    launchGitFingerprint: 'anchor',
    previousHash: '0'.repeat(64),
    hash: '0'.repeat(64),
    hook: 'fixture',
    kind: 'prompt_submission',
    text: '',
    redacted: false,
    truncated: false,
    ...value,
  });
}

describe('compact evidence briefing', () => {
  it.each(WORKFLOWS)(
    'retains every acceptance requirement from the $id failure before setup instructions and tool noise',
    (task) => {
      const prompt = [
        task.request,
        'Operator acceptance requirements:',
        ...task.requirements.map((text, index) => `${index + 1}. ${text}`),
        `First stage only: inspect the files and implement ${task.firstStage}. Leave the remaining implementation for later. Do not write notes. Do not change tests. Use only this workspace.`,
      ].join('\n\n');
      expect(prompt.length).toBeGreaterThan(900);
      const source = event(1, { text: prompt });
      const noise = Array.from({ length: 10 }, (_, index) =>
        event(index + 2, {
          kind: 'tool_result',
          command: `inspect ${index}`,
          text: 'older output '.repeat(100),
          outcome: 'reported_failure',
        }),
      );
      const briefing = renderEvidenceBriefing([source, ...noise], {
        warnings: [],
        pendingTools: [],
        workspace: '/current/worktree',
      });
      for (const requirement of task.requirements)
        expect(briefing.text).toContain(requirement);
      expect(briefing.selectedEvidence).toContainEqual({
        eventId: source.id,
        start: 0,
        end: prompt.length,
        text: prompt,
      });
      expect(briefing.partialEvents).not.toContain(source.id);
      expect(briefing.submissionCoverage).toMatchObject({
        retained: 1,
        fullyInlined: 1,
        requiredSourceIds: [],
      });
      expect(briefing.text.indexOf('submitted message')).toBeLessThan(
        briefing.text.indexOf('Execution'),
      );
      expect(briefing.text.length).toBeLessThanOrEqual(6000);
    },
  );

  it('keeps uncued requirements and later corrections whole and ordered', () => {
    const earlier = event(1, {
      text:
        'The inclusive boundary is part of the contract. ' +
        'Plain specification text. '.repeat(45),
    });
    const later = event(2, {
      text: 'Correction: the expiry boundary is now strict; equality stays valid.',
    });
    const briefing = renderEvidenceBriefing([earlier, later], {
      warnings: [],
      pendingTools: [],
    });
    expect(briefing.selectedEvidence.map((excerpt) => excerpt.text)).toEqual([
      earlier.text,
      later.text,
    ]);
    expect(briefing.text.indexOf(earlier.id)).toBeLessThan(
      briefing.text.indexOf(later.id),
    );
    expect(briefing.submissionCoverage.fullyInlined).toBe(2);
  });

  it('requires lookup for every unshown submission and preserves newer complete messages under pressure', () => {
    const older = event(1, { text: 'A'.repeat(8000) });
    const latest = event(2, {
      text: 'Correction: use cents, preserve duplicates, and return copies.',
    });
    const briefing = renderEvidenceBriefing([older, latest], {
      warnings: [],
      pendingTools: [],
      maxCharacters: 1200,
    });
    expect(briefing.text).toContain(latest.text);
    expect(briefing.submissionCoverage).toMatchObject({
      retained: 2,
      fullyInlined: 1,
      requiredSourceIds: [older.id],
    });
    expect(briefing.text).toContain(
      'REQUIRED BEFORE EDITING: relay context task',
    );
    expect(briefing.text).toContain('nextAfter with --after until null');
    expect(briefing.text.length).toBeLessThanOrEqual(1200);
  });

  it('distinguishes complete retained text from already truncated or redacted capture', () => {
    const source = event(1, {
      text: 'Partial retained instructions',
      truncated: true,
      redacted: true,
    });
    const briefing = renderEvidenceBriefing([source], {
      warnings: [],
      pendingTools: [],
    });
    expect(briefing.submissionCoverage).toMatchObject({
      fullyInlined: 1,
      truncatedSourceIds: [source.id],
      redactedSourceIds: [source.id],
    });
    expect(briefing.text).toContain('lookup cannot recover missing text');
  });

  it.each(['/old/worktree', 'C:\\old\\worktree', '\\\\server\\old'])(
    'keeps historical paths out of previews without rewriting the source (%s)',
    (oldPath) => {
      const source = event(1, {
        kind: 'tool_result',
        command: `cd "${oldPath}" && npm test`,
        text: `${oldPath}\nTests failed`,
        exitCode: 1,
        outcome: 'reported_failure',
      });
      const edit = event(2, {
        kind: 'tool_result',
        toolName: 'Edit',
        filePath: `${oldPath}/src/file.mjs`,
        outcome: 'reported_success',
        text: 'edit',
      });
      const claim = event(3, {
        kind: 'assistant_claim',
        text: `Check "${oldPath}/src/file.mjs" next.`,
      });
      const before = JSON.stringify([source, edit, claim]);
      const briefing = renderEvidenceBriefing([source, edit, claim], {
        warnings: [],
        pendingTools: [],
        workspace: '/actual/worktree',
      });
      expect(briefing.text).toContain('Current workspace: "/actual/worktree"');
      expect(briefing.text).toContain('reported command exit 1');
      expect(briefing.text).toContain('historical absolute path');
      expect(briefing.text).not.toContain(oldPath);
      expect(briefing.partialEvents).toContain(source.id);
      expect(JSON.stringify([source, edit, claim])).toBe(before);
    },
  );

  it('keeps the budget even with many coverage problems and an oversized workspace path', () => {
    const source = event(1, {
      text: '😀'.repeat(8000),
      truncated: true,
      redacted: true,
    });
    const briefing = renderEvidenceBriefing([source], {
      maxCharacters: 1200,
      workspace: '/workspace/' + 'x'.repeat(3000),
      pendingTools: [source.id],
      warnings: [
        'no captured session start',
        'no captured session end',
        'known gap',
        'tail',
        'truncated',
        'redacted',
        'limit was reached',
        'unsupported',
        'launch anchor',
      ],
    });
    expect(briefing.text.length).toBeLessThanOrEqual(1200);
    expect(briefing.text.isWellFormed()).toBe(true);
    expect(briefing.submissionCoverage.requiredSourceIds).toEqual([source.id]);
  });

  it('surfaces a complete late correction from an over-budget message with exact source spans', () => {
    const correction =
      'Correction: preserve the public API and add no dependencies.';
    const events = [
      event(1, {
        text: `${'Earlier exploration detail. '.repeat(400)}\n\n${correction}`,
      }),
    ];
    for (const maxCharacters of [1200, 3200, 6000]) {
      const briefing = renderEvidenceBriefing(events, {
        warnings: [],
        pendingTools: [],
        maxCharacters,
      });
      expect(briefing.text).toContain(correction);
      expect(briefing.text.length).toBeLessThanOrEqual(maxCharacters);
      expect(briefing.partialEvents).toContain(events[0]!.id);
      expect(briefing.submissionCoverage.requiredSourceIds).toEqual([
        events[0]!.id,
      ]);
      expect(briefing.text).toContain('REQUIRED BEFORE EDITING');
      for (const excerpt of briefing.selectedEvidence)
        expect(excerpt.text).toBe(
          events
            .find((item) => item.id === excerpt.eventId)!
            .text.slice(excerpt.start, excerpt.end),
        );
    }
  });

  it('distinguishes numeric command failure from a successful tool hook and later edits', () => {
    const events = [
      event(1, {
        kind: 'tool_start',
        toolId: 'test',
        toolName: 'Bash',
        command: 'npm test',
        text: 'requested',
      }),
      event(2, {
        kind: 'tool_result',
        toolId: 'test',
        toolName: 'Bash',
        command: 'npm test',
        outcome: 'reported_success',
        exitCode: 1,
        text: 'isolation failed',
      }),
      event(3, {
        kind: 'tool_result',
        toolId: 'edit',
        toolName: 'Edit',
        outcome: 'reported_success',
        filePath: 'src/cache.ts',
        text: 'edited',
      }),
      event(4, { kind: 'assistant_claim', text: 'All tests passed now.' }),
    ];
    const briefing = renderEvidenceBriefing(events, {
      warnings: [],
      pendingTools: [],
    });
    expect(briefing.text).toContain('reported command exit 1');
    expect(briefing.text).toContain('UNVERIFIED after edits');
    expect(briefing.text).toContain('UNVERIFIED ASSISTANT CLAIM');
    expect(briefing.text).toContain('src/cache.ts');
    expect(briefing.text).not.toContain('Pending tool');
    expect(briefing.omittedEvents).toBe(0);
  });

  it('presents the latest command result and cites earlier failures without repeating completed requests', () => {
    const events = [
      event(1, {
        kind: 'tool_result',
        command: 'npm test',
        toolId: 'old',
        outcome: 'reported_failure',
        text: 'old failure',
      }),
      event(2, {
        kind: 'tool_start',
        command: 'npm test',
        toolId: 'new',
        text: 'requested',
      }),
      event(3, {
        kind: 'tool_result',
        command: 'npm test',
        toolId: 'new',
        outcome: 'reported_success',
        exitCode: 0,
        text: 'command exited zero',
      }),
    ];
    const briefing = renderEvidenceBriefing(events, {
      warnings: [],
      pendingTools: [],
    });
    expect(briefing.text).toContain('reported command exit 0');
    expect(briefing.text).toContain(
      `Earlier failure source(s): [${events[0]!.id}]`,
    );
    expect(briefing.text.match(/Execution /g)).toHaveLength(1);
    expect(briefing.omittedEvents).toBe(0);
  });

  it('keeps pending results unknown and never instructs rerunning a historical command', () => {
    const pending = event(1, {
      kind: 'tool_start',
      command: 'dangerous historical command',
      toolId: 'pending',
      text: 'requested',
    });
    const briefing = renderEvidenceBriefing([pending], {
      warnings: [],
      pendingTools: [pending.id],
    });
    expect(briefing.text).toContain('Outcome unknown');
    expect(briefing.text).toContain('choose relevant verification');
    expect(briefing.text).not.toContain('rerun dangerous');
  });

  it('does not split surrogate pairs while quoting long tool output', () => {
    const output = event(1, {
      kind: 'tool_result',
      command: 'inspect',
      text: `x${'😀'.repeat(500)}`,
      outcome: 'reported_success',
    });
    const briefing = renderEvidenceBriefing([output], {
      warnings: [],
      pendingTools: [],
    });
    expect(briefing.selectedEvidence[0]!.text.isWellFormed()).toBe(true);
    expect(briefing.partialEvents).toEqual([output.id]);
  });
});

describe('comparative benchmark contract', () => {
  it('prepares twelve controlled inputs without calling a provider and preserves its frozen baseline', async () => {
    const temporary = await mkdtemp(
      path.join(os.tmpdir(), 'rirei-compare-test-'),
    );
    try {
      const { report } = await compare({
        output: path.join(temporary, 'trial'),
      });
      expect(report.providerSessions).toBe(0);
      expect(report.rows).toHaveLength(12);
      for (const task of new Set(report.rows.map((row) => row.task))) {
        const rows = report.rows.filter((row) => row.task === task);
        expect(new Set(rows.map((row) => row.arm))).toEqual(new Set(ARMS));
        expect(new Set(rows.map((row) => row.codeInputHash)).size).toBe(1);
        expect(new Set(rows.map((row) => row.historyHash)).size).toBe(1);
        expect(rows.every((row) => row.execution === null)).toBe(true);
      }
      const pressure = report.rows.filter(
        (row) => row.task === 'budget-pressure',
      );
      expect(
        pressure.find((row) => row.arm === 'rirei-v1')!.inlineTargetCount,
      ).toBe(0);
      expect(
        pressure.find((row) => row.arm === 'rirei-v2')!.inlineTargetCount,
      ).toBe(1);
      const source = await readFile(
        new URL(
          '../../benchmarks/continuity/baselines/rirei-v1.ts',
          import.meta.url,
        ),
      );
      expect(
        createHash('sha1')
          .update(`blob ${source.length}\0`)
          .update(source)
          .digest('hex'),
      ).toBe(report.baselineBlob);
    } finally {
      await rm(temporary, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it('uses the approved model, sandbox, and noninteractive settings without bypass flags', () => {
    const args = codexArguments({ model: 'gpt-5.6-sol', effort: 'low' });
    expect(args).toContain('workspace-write');
    expect(args).toContain('--ignore-user-config');
    expect(args).toContain('--ephemeral');
    expect(args.join(' ')).not.toContain('dangerously');
    expect(args).toContain('features.multi_agent=false');
  });

  it('keeps missing usage unknown and counts failed continuations as failures', () => {
    const report = summarize([
      {
        arm: 'rirei-v2',
        promptCharacters: 100,
        preparationMs: 1,
        execution: {
          exitCode: 0,
          timedOut: false,
          wallTimeMs: 10,
          metrics: { nonCachedTokens: null },
        },
        evidenceIntact: true,
        grading: { passed: true },
      },
      {
        arm: 'rirei-v2',
        promptCharacters: 100,
        preparationMs: 1,
        execution: {
          exitCode: 1,
          timedOut: false,
          wallTimeMs: 10,
          metrics: { nonCachedTokens: 5 },
        },
        evidenceIntact: true,
        grading: { passed: false },
      },
    ]).find((row) => row.arm === 'rirei-v2');
    expect(report).toMatchObject({
      correct: 1,
      failures: 1,
      nonCachedTokens: null,
    });
  });
});
