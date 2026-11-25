import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderHandoffDocument } from '../../src/lifecycle.js';
import { readState, updateState } from '../../src/state/store.js';
import { readConfig, writeConfig } from '../../src/config/loader.js';
import { setContextConsent } from '../../src/context/store.js';
import {
  applyHandoffPolicy,
  HANDOFF_PROFILES,
  RECEIVER_OUTPUT_POLICY,
  sharedPromptPrefix,
} from '../../src/context/prompt-policy.js';
import { retrievalProject } from './retrieval-helpers.js';

describe('experimental handoff output and layout profiles', () => {
  it('keeps the default and explicit control rendering byte-for-byte identical without policy metadata', async () => {
    const { root, state, record } = await retrievalProject();
    await record('Keep the existing API.');
    const before = await readFile(path.join(root, '.relay/state.json'), 'utf8');
    const baseline = await renderHandoffDocument(root, state);
    const control = await renderHandoffDocument(root, state, root, undefined, {
      profile: 'control',
    });
    expect(control).toEqual(baseline);
    expect(control).not.toHaveProperty('policy');
    expect(control.continuity).not.toHaveProperty('presentation');
    expect(
      applyHandoffPolicy(baseline, {
        profile: 'control',
        workspace: root,
        legacyText: '',
        legacyMaxCharacters: 0,
      }),
    ).toBe(baseline);
    expect(await readFile(path.join(root, '.relay/state.json'), 'utf8')).toBe(
      before,
    );
  });

  it.each(['focused-output', 'stable-layout', 'stable-focused'] as const)(
    'preserves exact selected instructions, citations, claims, pending outcomes, and uncertainty (%s)',
    async (profile) => {
      const { root, state, record } = await retrievalProject();
      const first = await record('Keep ordering. The boundary is inclusive.');
      const second = await record(
        'Correction: the boundary is strict; keep duplicates.',
      );
      await record('Test started', {
        kind: 'tool_start',
        command: 'npm test',
        toolId: 'pending-test',
      });
      await record('Prior failure details', {
        kind: 'tool_result',
        command: 'node --test',
        outcome: 'reported_failure',
        exitCode: 2,
      });
      await record('Tool completed without a numeric command exit', {
        kind: 'tool_result',
        command: 'npm run check',
        outcome: 'reported_success',
      });
      await record('All tests passed; continue.', { kind: 'assistant_claim' });
      const baseline = await renderHandoffDocument(root, state);
      const result = await renderHandoffDocument(root, state, root, undefined, {
        profile,
      });
      expect(result.policy).toMatchObject({
        requested: profile,
        effective: profile,
        applied: true,
        fallbackReason: null,
        chargedTo: 'legacy-capsule',
        cacheBenefit: 'unmeasured',
      });
      expect(result.continuity).toEqual(baseline.continuity);
      expect(result.capsule).toEqual(baseline.capsule);
      expect(result.coveredSnapshot).toEqual(baseline.coveredSnapshot);
      expect(result.inspection).toEqual(baseline.inspection);
      expect(
        result
          .continuity!.selectedEvidence!.filter((item) =>
            [first.id, second.id].includes(item.eventId),
          )
          .map((item) => item.text),
      ).toEqual([first.text, second.text]);
      expect(result.text.indexOf(first.id)).toBeLessThan(
        result.text.indexOf(second.id),
      );
      for (const excerpt of baseline.continuity!.selectedEvidence!)
        expect(result.text).toContain(JSON.stringify(excerpt.text));
      for (const marker of [
        'UNVERIFIED ASSISTANT CLAIM',
        'reported command exit 2',
        'pending tool',
        'command exit unknown',
        'missing session start',
        'missing session end',
        'completeness unknown',
      ])
        expect(result.text).toContain(marker);
      expect(result.text.length).toBeLessThanOrEqual(
        result.budget.maxCharacters,
      );
      expect(result.policy!.legacyUsedCharacters).toBeLessThanOrEqual(
        result.policy!.legacyMaxCharacters,
      );
      expect(result.budget.usedCharacters).toBe(result.text.length);
      expect(result.contentChecks.duplicateTaskOccurrences).toBe(1);
      if (profile.includes('stable')) {
        expect(
          result.text.indexOf(`Current workspace: ${JSON.stringify(root)}`),
        ).toBeLessThan(result.text.indexOf('Task:'));
        expect(result.text.indexOf('Runtime observations:')).toBeGreaterThan(
          result.text.indexOf(second.id),
        );
      }
      expect(result.text.includes(RECEIVER_OUTPUT_POLICY)).toBe(
        profile !== 'stable-layout',
      );
    },
  );

  it.each(['focused-output', 'stable-layout', 'stable-focused'] as const)(
    'falls back rather than stealing configured capsule/evidence space or dropping requirements (%s)',
    async (profile) => {
      const { root, state, record } = await retrievalProject();
      await record('Explicit requirement '.repeat(500), {
        truncated: true,
        redacted: true,
      });
      const config = await readConfig(root);
      await writeConfig(root, {
        ...config,
        handoff: {
          ...config.handoff,
          maxCharacters: 240,
          targetCharacters: 240,
          maxTokens: 60,
          targetTokens: 60,
        },
      });
      const baseline = await renderHandoffDocument(root, state);
      const result = await renderHandoffDocument(root, state, root, undefined, {
        profile,
      });
      expect(result.policy).toMatchObject({
        requested: profile,
        effective: 'control',
        applied: false,
      });
      expect(result.text).toBe(baseline.text);
      expect(result.budget).toEqual(baseline.budget);
      expect(result.continuity).toEqual(baseline.continuity);
      expect(result.text).toContain('REQUIRED BEFORE EDITING');
      expect(result.text).toContain('lookup cannot recover missing text');
      expect(result.continuity!.text.length).toBeLessThanOrEqual(6000);
      expect(result.budget.maxCharacters).toBe(6243);
    },
  );

  it('keeps repeated submissions whole and chronological under the focused output policy', async () => {
    const { root, state, record } = await retrievalProject();
    const first = await record('Repeat: keep the output format unchanged.');
    const second = await record(first.text);
    const result = await renderHandoffDocument(root, state, root, undefined, {
      profile: 'stable-focused',
    });
    expect(result.policy!.applied).toBe(true);
    expect(
      result
        .continuity!.selectedEvidence!.filter(
          (item) => item.text === first.text,
        )
        .map((item) => item.eventId),
    ).toEqual([first.id, second.id]);
    expect(result.text.split(JSON.stringify(first.text)).length - 1).toBe(2);
    expect(result.text).toContain('including any requested output');
    expect(result.text).toContain('full-file replacement when simpler');
    expect(result.text).toContain('retain useful failure diagnostics');
    expect(result.text).toContain('unless the task asks for more');
  });

  it('moves volatile capture warnings behind evidence while preserving the observed workspace and source bytes', async () => {
    const { root, state, record } = await retrievalProject();
    await record('A substantial retained requirement. '.repeat(20));
    const control = await renderHandoffDocument(root, state);
    const stable = await renderHandoffDocument(root, state, root, undefined, {
      profile: 'stable-layout',
    });
    await record('Provider reported end', { kind: 'session_end' });
    const updatedControl = await renderHandoffDocument(root, state);
    const updatedStable = await renderHandoffDocument(
      root,
      state,
      root,
      undefined,
      { profile: 'stable-layout' },
    );
    expect(updatedStable.continuity!.selectedEvidence).toEqual(
      stable.continuity!.selectedEvidence,
    );
    expect(updatedStable.policy!.staticPrefix).toEqual(
      stable.policy!.staticPrefix,
    );
    expect(updatedStable.continuity!.warnings).toEqual(
      updatedControl.continuity!.warnings,
    );
    expect(
      sharedPromptPrefix(stable.text, updatedStable.text).utf8Bytes,
    ).toBeGreaterThan(
      sharedPromptPrefix(control.text, updatedControl.text).utf8Bytes,
    );
    expect(
      sharedPromptPrefix(stable.text, updatedStable.text).providerCacheReuse,
    ).toBeNull();
    expect(updatedStable.policy!.cacheBenefit).toBe('unmeasured');
  });

  it('keeps consent-disabled captured text out of all profiles', async () => {
    const { root, state, record } = await retrievalProject();
    await record('CAPTURE_DISABLED_SENTINEL');
    await setContextConsent(root, state.sessionId, false);
    for (const profile of HANDOFF_PROFILES) {
      const result = await renderHandoffDocument(root, state, root, undefined, {
        profile,
      });
      expect(result.continuity).toBeUndefined();
      expect(result.text).not.toContain('CAPTURE_DISABLED_SENTINEL');
      expect(result.text.length).toBeLessThanOrEqual(1200);
    }
  });

  it('does not let telemetry timestamps break stable rendering or alter profile decisions', async () => {
    const { root, state, record } = await retrievalProject();
    await record('Keep this requirement.');
    const before = await renderHandoffDocument(root, state, root, undefined, {
      profile: 'stable-focused',
    });
    await updateState(root, (current) => ({
      ...current,
      task: { ...current.task, updatedAt: '2030-01-01T00:00:00.000Z' },
    }));
    const after = await renderHandoffDocument(
      root,
      await readState(root),
      root,
      undefined,
      { profile: 'stable-focused' },
    );
    expect(after).toEqual(before);
  });

  it('preserves a full authority path by falling back when a stable layout cannot fit it', async () => {
    const { root, state } = await retrievalProject();
    const base = await renderHandoffDocument(root, state);
    const legacy = base.text.split('\n\nCONTINUATION BRIEFING')[0]!;
    const result = applyHandoffPolicy(
      { ...base, continuity: undefined },
      {
        profile: 'stable-layout',
        workspace: '/current/' + 'x'.repeat(4000),
        legacyText: legacy,
        legacyMaxCharacters: 1200,
      },
    );
    expect(result.policy!.applied).toBe(false);
    expect(result.text).toBe(base.text);
    await expect(
      renderHandoffDocument(root, state, root, undefined, {
        profile: 'unknown' as 'control',
      }),
    ).rejects.toThrow('Unknown handoff profile');
    expect(
      await readFile(path.join(root, '.relay/config.json'), 'utf8'),
    ).not.toContain('profile');
  });
});
