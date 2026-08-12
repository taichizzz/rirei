import { describe, expect, it } from 'vitest';
import {
  buildHandoffCapsule,
  hasContinuationNotes,
  renderCompactHandoff,
} from '../src/handoff.js';
import type { RelayConfig } from '../src/config/schema.js';
import type { GitSnapshot } from '../src/git/repository.js';
import type { HandoffNote, RelayState } from '../src/state/schema.js';

const DEFAULTS: RelayConfig['handoff'] = {
  maxCharacters: 1_200,
  maxTokens: 300,
  targetCharacters: 1_200,
  targetTokens: 300,
};

function snapshot(overrides: Partial<GitSnapshot> = {}): GitSnapshot {
  return {
    root: '/repo',
    branch: 'main',
    commit: '4e951dbbc70f1bd2ce55eb86d12cb2e011c0321e',
    fingerprint: 'f'.repeat(64),
    status: '',
    changedFiles: [],
    patch: '',
    patchTruncated: false,
    isBare: false,
    ...overrides,
  };
}

function note(
  type: HandoffNote['type'],
  text: string,
  overrides: Partial<HandoffNote> = {},
): HandoffNote {
  return {
    id: `note-${type}`,
    type,
    text,
    createdAt: '2026-01-01T00:00:00.000Z',
    provenance: { source: 'user', recordedBy: 'relay-cli' },
    git: { commit: 'abc', branch: 'main', fingerprint: 'f' },
    ...overrides,
  };
}

function state(): RelayState {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    schemaVersion: 4,
    revision: 0,
    recentOperations: [],
    runs: [],
    sessionId: 'session',
    projectRoot: '/repo',
    task: {
      title: 'Implement retry parsing',
      originalRequest:
        'Implement retry parsing: accept integer and IMF-fixdate values, clamp to MAX_TIMEOUT_MS.',
      requirements: [],
      constraints: [],
      status: 'active',
      createdAt: now,
      updatedAt: now,
    },
    git: { startingCommit: 'abc', startingBranch: 'main', dirtyAtStart: false },
    agentHistory: [],
    decisions: [],
    completedWork: [],
    remainingWork: [],
    tests: [],
    checkpoints: [],
    blockers: [],
    notes: [],
  };
}

function render(
  stateValue: RelayState,
  snapshotValue: GitSnapshot,
  config: RelayConfig['handoff'] = DEFAULTS,
) {
  return renderCompactHandoff(
    buildHandoffCapsule(stateValue, snapshotValue, 5),
    config,
  );
}

describe('handoff task rendering', () => {
  it('renders a one-line request exactly once', () => {
    const value = state();
    value.task.title = 'Do the thing';
    value.task.originalRequest = 'Do the thing';
    const rendered = render(value, snapshot({ status: '', changedFiles: [] }));
    expect(rendered.contentChecks.duplicateTaskOccurrences).toBe(1);
    expect(rendered.text.split('Do the thing').length - 1).toBe(1);
    expect(rendered.text).toContain('Task: Do the thing');
  });

  it('does not duplicate when the title is a prefix of a detailed request', () => {
    const value = state();
    value.task.title = 'Implement retry parsing';
    value.task.originalRequest =
      'Implement retry parsing: accept integer and IMF-fixdate values, clamp to MAX_TIMEOUT_MS.';
    const rendered = render(value, snapshot());
    expect(rendered.contentChecks.duplicateTaskOccurrences).toBe(1);
    expect(rendered.text).not.toMatch(/Task: Implement retry parsing\n+Task:/);
    expect(rendered.text).toContain(
      'Task: Implement retry parsing: accept integer and IMF-fixdate values, clamp to MAX_TIMEOUT_MS.',
    );
  });
});

describe('handoff content rules', () => {
  it('contains no note-capture instruction even after batch capture', () => {
    const value = state();
    value.notes = [note('next', 'IMF-fixdate'), note('rejected', 'parseInt')];
    const rendered = render(value, snapshot());
    expect(rendered.contentChecks.containsNoteInstruction).toBe(false);
    expect(rendered.text).not.toMatch(/relay\s+note/i);
    expect(rendered.text).not.toMatch(/record|placeholder/i);
  });

  it('stays within 1,200 characters and 300 estimated tokens', () => {
    const value = state();
    value.notes = [
      note('next', 'Handle IMF-fixdate validation and clamp past dates.'),
      note('blocker', 'Refresh endpoint still returns 401.'),
      note('rejected', 'parseInt accepts malformed numeric prefixes.'),
      note(
        'decision',
        'Use monotonic time so wall-clock changes cannot revive entries.',
      ),
      note('done', 'Foundation implemented and public tests pass.'),
      note('done', 'Header lookup wired.'),
    ];
    value.tests = [
      {
        command: 'npm test',
        status: 'failed',
        summary: '1 test failed',
        lastRunAt: '2026-01-01T00:00:00.000Z',
        exitCode: 1,
      },
    ];
    const rendered = render(value, snapshot({ status: ' M README.md' }));
    expect(rendered.budget.usedCharacters).toBeLessThanOrEqual(1_200);
    expect(rendered.budget.estimatedTokens).toBeLessThanOrEqual(300);
  });

  it('omits done notes, passed tests, and changed files from text but keeps them in JSON', () => {
    const value = state();
    value.notes = [
      note('next', 'Continue'),
      note('done', 'Completed work detail'),
    ];
    value.completedWork = [{ description: 'legacy completed' }];
    value.tests = [
      {
        command: 'npm test',
        status: 'passed',
        lastRunAt: '2026-01-01T00:00:00.000Z',
        exitCode: 0,
      },
    ];
    const rendered = render(
      value,
      snapshot({ status: 'M README.md\n?? new.txt', changedFiles: [] }),
    );
    expect(rendered.text).not.toContain('Completed work detail');
    expect(rendered.text).not.toContain('legacy completed');
    expect(rendered.text).not.toContain('changedFiles');
    expect(
      rendered.capsule.notes.some(
        (entry) => entry.text === 'Completed work detail',
      ),
    ).toBe(true);
    expect(rendered.capsule.legacy.completedWork).toHaveLength(1);
    expect(rendered.capsule.tests[0]?.status).toBe('passed');
  });

  it('retains resolved notes in JSON while omitting them from text', () => {
    const value = state();
    value.notes = [
      note('next', 'Already handled', {
        resolvedAt: '2026-01-02T00:00:00.000Z',
      }),
      note('next', 'Continue with current work'),
    ];
    const rendered = render(value, snapshot());
    expect(rendered.capsule.notes).toContainEqual(
      expect.objectContaining({
        text: 'Already handled',
        resolvedAt: '2026-01-02T00:00:00.000Z',
      }),
    );
    expect(rendered.text).not.toContain('Already handled');
    expect(rendered.text).toContain('Continue with current work');
  });

  it('prioritizes next and blocker over decision, done, and changed files', () => {
    const value = state();
    value.notes = [
      note('next', 'Next work'),
      note('decision', 'Decision rationale'),
      note('done', 'Done detail'),
    ];
    const rendered = render(value, snapshot());
    const nextIndex = rendered.text.indexOf('Next: Next work');
    const decisionIndex = rendered.text.indexOf('Decision: Decision rationale');
    expect(nextIndex).toBeGreaterThanOrEqual(0);
    expect(decisionIndex).toBeGreaterThanOrEqual(0);
    expect(nextIndex).toBeLessThan(decisionIndex);
    expect(rendered.text).not.toContain('Done detail');
  });

  it('keeps changed and diverged freshness visible for rendered notes', () => {
    const value = state();
    value.notes = [
      note('next', 'Stale note', {
        git: { commit: 'old', branch: 'main', fingerprint: 'g' },
      }),
    ];
    const rendered = render(
      value,
      snapshot({ commit: '4e951dbbc70f1bd2ce55eb86d12cb2e011c0321e' }),
    );
    expect(rendered.text).toMatch(/Next: Stale note \[diverged\]/);
  });

  it('bounds long ASCII and Unicode requests at a Unicode-safe boundary', () => {
    const longAscii = 'a'.repeat(5_000);
    const emoji = '🔥'.repeat(3_000);
    const value = state();
    value.task.originalRequest = longAscii;
    const rendered = render(value, snapshot());
    expect(rendered.budget.usedCharacters).toBeLessThanOrEqual(1_200);
    const taskLine = rendered.text.split('\n\n')[0] ?? '';
    expect(taskLine).toMatch(/^Task: /);
    expect(taskLine.endsWith('…')).toBe(true);
    expect(rendered.text).toContain('Git:');
    expect(rendered.contentChecks.duplicateTaskOccurrences).toBe(1);

    value.task.originalRequest = emoji;
    const unicodeRendered = render(value, snapshot());
    expect(unicodeRendered.budget.usedCharacters).toBeLessThanOrEqual(1_200);
    expect(() => new TextEncoder().encode(unicodeRendered.text)).not.toThrow();
    expect(unicodeRendered.text).not.toContain('\uFFFD');
  });

  it('respects very small user-configured ceilings', () => {
    const value = state();
    const rendered = render(value, snapshot(), {
      maxCharacters: 80,
      maxTokens: 20,
      targetCharacters: 1_200,
      targetTokens: 300,
    });
    expect(rendered.budget.usedCharacters).toBeLessThanOrEqual(80);
    expect(rendered.budget.estimatedTokens).toBeLessThanOrEqual(20);
  });

  it('reports omission counts even when the omission line cannot fit', () => {
    const value = state();
    value.notes = [
      note('next', 'One'),
      note('next', 'Two'),
      note('next', 'Three'),
      note('next', 'Four'),
      note('next', 'Five'),
    ];
    const rendered = render(value, snapshot(), {
      maxCharacters: 200,
      maxTokens: 50,
      targetCharacters: 1_200,
      targetTokens: 300,
    });
    expect(rendered.budget.omittedItems).toBeGreaterThan(0);
    expect(rendered.text).toContain('Next:');
    expect(rendered.text).not.toContain('Omitted:');
  });

  it('does not let older next notes starve the latest blocker', () => {
    const value = state();
    value.notes = [
      note('blocker', 'Latest blocker'),
      note('next', 'Older next one', { createdAt: '2025-12-01T00:00:00.000Z' }),
      note('next', 'Older next two', { createdAt: '2025-11-01T00:00:00.000Z' }),
      note('next', 'Latest next'),
    ];
    const rendered = render(value, snapshot(), {
      maxCharacters: 260,
      maxTokens: 65,
      targetCharacters: 1_200,
      targetTokens: 300,
    });
    expect(rendered.text).toContain('Next: Latest next');
    expect(rendered.text).toContain('Blocked: Latest blocker');
  });

  it('truncates a mandatory next item instead of dropping it', () => {
    const value = state();
    value.notes = [note('next', 'continue '.repeat(100))];
    const rendered = render(value, snapshot(), {
      maxCharacters: 220,
      maxTokens: 55,
      targetCharacters: 1_200,
      targetTokens: 300,
    });
    expect(rendered.text).toMatch(/Next: .*…/);
    expect(rendered.budget.usedCharacters).toBeLessThanOrEqual(220);
  });
});

describe('continuation note detection', () => {
  it('treats unresolved next/blocker/rejected/decision/question as continuation', () => {
    for (const type of [
      'next',
      'blocker',
      'rejected',
      'decision',
      'question',
    ]) {
      expect(hasContinuationNotes([note(type, 'x')])).toBe(true);
    }
  });

  it('ignores done notes and resolved notes', () => {
    expect(hasContinuationNotes([note('done', 'x')])).toBe(false);
    expect(
      hasContinuationNotes([
        note('next', 'x', { resolvedAt: '2026-01-02T00:00:00.000Z' }),
      ]),
    ).toBe(false);
  });
});
