import { describe, expect, it } from 'vitest';
import {
  analyzePolicyExperiment,
  createPolicyExperiment,
} from '../../benchmarks/continuity/policy-experiment.mjs';

function observations(protocol: ReturnType<typeof createPolicyExperiment>) {
  return protocol.schedule.map((row, index) => {
    const candidate = row.profile !== 'control';
    const input = 320;
    const cached = candidate ? 230 : 200;
    const output = candidate ? 20 : 30;
    const records =
      row.receiver === 'codex'
        ? [
            { type: 'turn.started' },
            {
              type: 'item.started',
              item: {
                id: 'one',
                type: 'command_execution',
                command: 'node --test',
              },
            },
            {
              type: 'item.completed',
              item: {
                id: 'one',
                type: 'command_execution',
                exit_code: 0,
                aggregated_output: 'ok',
              },
            },
            {
              type: 'turn.completed',
              usage: {
                input_tokens: input,
                cached_input_tokens: cached,
                output_tokens: output,
                reasoning_output_tokens: 6,
              },
            },
          ]
        : [
            { type: 'system', subtype: 'init', model: 'fixture-sonnet' },
            {
              type: 'assistant',
              message: {
                content: [
                  {
                    type: 'tool_use',
                    id: 'one',
                    name: 'Bash',
                    input: { command: 'node --test' },
                  },
                ],
              },
            },
            {
              type: 'result',
              num_turns: 1,
              usage: {
                input_tokens: input - cached - 20,
                cache_read_input_tokens: cached,
                cache_creation_input_tokens: 20,
                output_tokens: output,
              },
            },
          ];
    const duration = candidate ? 80 : 100;
    return {
      protocolHash: protocol.hash,
      key: row.key,
      provider: row.receiver,
      cliVersion: `fixture-${row.receiver}-1`,
      requestedModel: `fixture-${row.receiver}`,
      effort: 'low',
      actualModel: null,
      startedAt: new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString(),
      endedAt: new Date(
        Date.UTC(2026, 0, 1) + index * 1000 + duration,
      ).toISOString(),
      wallTimeMs: duration,
      status: 'completed',
      acceptancePassed: true,
      strictSuccess: true,
      traceComplete: true,
      policyApplied: candidate,
      visibleJsonl:
        records.map((record) => JSON.stringify(record)).join('\n') + '\n',
    };
  });
}

describe('offline output/cache experiment contracts', () => {
  it.each(['output', 'layout', 'combined'])(
    'balances AB/BA within each receiving provider and isolates the %s contrast',
    (contrast) => {
      const plan = createPolicyExperiment({ contrast });
      expect(plan.plannedLaunches).toBe(8);
      expect(plan.authorizedLaunches).toBe(0);
      expect(plan.cacheCondition).toBe('uncontrolled');
      expect(new Set(plan.schedule.map((row) => row.key)).size).toBe(8);
      for (const provider of ['claude', 'codex']) {
        const first = plan.schedule.filter(
          (row) => row.receiver === provider && row.position === 0,
        );
        expect(first.map((row) => row.profile)).toEqual([
          'control',
          plan.profiles[1],
        ]);
      }
      expect(createPolicyExperiment({ contrast })).toEqual(plan);
      const repeated = createPolicyExperiment({ contrast, repetitions: 2 });
      expect(repeated.plannedLaunches).toBe(16);
      for (const row of plan.schedule.filter((row) => row.position === 0))
        expect(
          repeated.schedule.find(
            (next) =>
              next.caseIndex === row.caseIndex &&
              next.repetition === 1 &&
              next.position === 0,
          )!.profile,
        ).not.toBe(row.profile);
    },
  );

  it('leaves unobserved metrics and cache benefit unknown instead of manufacturing a saving', () => {
    const report = analyzePolicyExperiment(createPolicyExperiment());
    expect(report.recordedObservations).toBe(0);
    expect(report.providerSessionsLaunched).toBe(0);
    for (const row of report.receivers) {
      expect(row.cacheBenefit).toBe('unmeasured');
      expect(row.replicatedCachePattern).toBe(false);
      expect(
        Object.values(row.medianPairedDifferences).every(
          (value) => value === null,
        ),
      ).toBe(true);
    }
    expect(
      report.pairs.every(
        (pair) => !pair.qualified && pair.elapsedSpacingMs === null,
      ),
    ).toBe(true);
  });

  it('keeps provider cache creation/read, output, reasoning and non-cached counters separate', () => {
    const plan = createPolicyExperiment();
    const report = analyzePolicyExperiment(plan, observations(plan));
    const codex = report.pairs.find((pair) => pair.receiver === 'codex')!;
    expect(codex.control.metrics).toMatchObject({
      inputTokens: 320,
      cachedInputTokens: 200,
      cacheCreationInputTokens: null,
      outputTokens: 30,
      reasoningTokens: 6,
      nonCachedTokens: 150,
    });
    expect(codex.candidate.metrics).toMatchObject({
      outputTokens: 20,
      reasoningTokens: 6,
      nonCachedTokens: 110,
    });
    expect(codex.modelQualification).toBe('requested-model-only');
    const claude = report.pairs.find((pair) => pair.receiver === 'claude')!;
    expect(claude.control.metrics).toMatchObject({
      inputTokens: 320,
      cachedInputTokens: 200,
      cacheCreationInputTokens: 20,
      outputTokens: 30,
      reasoningTokens: null,
      nonCachedTokens: 150,
    });
    expect(claude.modelQualification).toBe('resolved-model');
    expect(
      report.receivers.every(
        (row) =>
          row.balancedObservedOrder &&
          !row.replicatedCases &&
          !row.replicatedCachePattern,
      ),
    ).toBe(true);
    expect(report.pairs.every((pair) => pair.elapsedSpacingMs! > 0)).toBe(true);
  });

  it('requires repeated case observations and no measured output/tool/time regression for a descriptive cache pattern', () => {
    const plan = createPolicyExperiment({ repetitions: 2 });
    const values = observations(plan);
    const report = analyzePolicyExperiment(plan, values);
    expect(report.receivers.every((row) => row.replicatedCachePattern)).toBe(
      true,
    );
    expect(
      report.receivers.every(
        (row) => row.cacheBenefit === 'descriptive-replicated-counter-pattern',
      ),
    ).toBe(true);
    const changed = values.map((value) =>
      value.key.endsWith('/focused-output')
        ? { ...value, wallTimeMs: 1000 }
        : value,
    );
    const slow = analyzePolicyExperiment(plan, changed);
    expect(slow.receivers.every((row) => !row.replicatedCachePattern)).toBe(
      true,
    );
    expect(slow.recommendation).toContain('No automatic promotion');
    const verbose = values.map((value) =>
      value.key.endsWith('/focused-output')
        ? {
            ...value,
            visibleJsonl: value.visibleJsonl.replace(
              '"output_tokens":20',
              '"output_tokens":60',
            ),
          }
        : value,
    );
    expect(
      analyzePolicyExperiment(plan, verbose).receivers.every(
        (row) => !row.replicatedCachePattern,
      ),
    ).toBe(true);
  });

  it('excludes mismatched runtimes, profile fallback, missing outcomes, broken traces and wrong ordering', () => {
    const plan = createPolicyExperiment();
    for (const mutation of [
      { cliVersion: 'different-version' },
      { requestedModel: 'different-model' },
      { effort: 'high' },
      { actualModel: 'different-model' },
      { policyApplied: false },
      { acceptancePassed: false },
      { strictSuccess: null },
      { traceComplete: false },
      { status: 'infrastructure-affected' },
      { startedAt: null },
      { startedAt: '2025-01-01T00:00:00.000Z' },
    ]) {
      const values = observations(plan);
      const index = plan.schedule.findIndex(
        (row) => row.caseIndex === 0 && row.profile !== 'control',
      );
      values[index] = { ...values[index]!, ...mutation };
      const report = analyzePolicyExperiment(plan, values);
      const pair = report.pairs.find((pair) => pair.caseIndex === 0)!;
      expect(pair.qualified).toBe(false);
      expect(pair.cacheReadFractionDelta).toBeNull();
      expect(
        Object.values(pair.differences).every((value) => value === null),
      ).toBe(true);
    }
  });

  it('does not pool different runtime groups or turn missing cache counters into zero', () => {
    const plan = createPolicyExperiment();
    const values = observations(plan);
    const mixed = values.map((value, index) =>
      plan.schedule[index]!.caseIndex === 2
        ? { ...value, cliVersion: 'second-version' }
        : value,
    );
    const report = analyzePolicyExperiment(plan, mixed);
    const codex = report.receivers.find((row) => row.provider === 'codex')!;
    expect(codex.stableRuntime).toBe(false);
    expect(codex.medianPairedDifferences.outputTokens).toBeNull();
    const missing = values.map((value) => ({
      ...value,
      visibleJsonl: value.visibleJsonl
        .replace(/,"cached_input_tokens":\d+/g, '')
        .replace(/,"cache_read_input_tokens":\d+/g, ''),
    }));
    const unknown = analyzePolicyExperiment(plan, missing);
    expect(
      unknown.pairs.every(
        (pair) =>
          pair.control.metrics.cachedInputTokens === null &&
          pair.control.metrics.nonCachedTokens === null,
      ),
    ).toBe(true);
    expect(
      unknown.receivers.every(
        (row) =>
          row.metricPairs.cachedInputTokens === 0 &&
          !row.replicatedCachePattern,
      ),
    ).toBe(true);
  });

  it('keeps provider error events and invalid counts out of cache qualification while reporting clean matched subsets', () => {
    const plan = createPolicyExperiment();
    const values = observations(plan);
    const affected = values.map((value, index) =>
      plan.schedule[index]!.caseIndex === 0 &&
      plan.schedule[index]!.profile !== 'control'
        ? {
            ...value,
            visibleJsonl:
              value.visibleJsonl +
              JSON.stringify({ type: 'turn.failed' }) +
              '\n',
          }
        : value,
    );
    const report = analyzePolicyExperiment(plan, affected);
    expect(report.pairs[0].qualified).toBe(false);
    expect(report.pairs[0].reasons).toContain(
      'candidate-provider-reported-error',
    );
    const codex = report.receivers.find((row) => row.provider === 'codex')!;
    expect(codex).toMatchObject({
      qualifiedPairs: 1,
      excludedPairs: 1,
      allPairsQualified: false,
      replicatedCachePattern: false,
    });
    expect(codex.metricPairs.outputTokens).toBe(1);
    const invalid = values.map((value) =>
      value.provider === 'codex'
        ? {
            ...value,
            visibleJsonl: value.visibleJsonl.replace(
              /"cached_input_tokens":\d+/g,
              '"cached_input_tokens":99999',
            ),
          }
        : value,
    );
    const counts = analyzePolicyExperiment(plan, invalid);
    expect(
      counts.pairs
        .filter((pair) => pair.receiver === 'codex')
        .every(
          (pair) =>
            pair.control.metrics.cachedInputTokens === null &&
            pair.candidate.metrics.nonCachedTokens === null,
        ),
    ).toBe(true);
    expect(
      counts.receivers.find((row) => row.provider === 'codex')!.cacheBenefit,
    ).toBe('not-qualified');
  });

  it('rejects duplicate/unscheduled observations and edited protocols rather than replacing attempts', () => {
    const plan = createPolicyExperiment();
    const values = observations(plan);
    expect(() => analyzePolicyExperiment(plan, [values[0], values[0]])).toThrow(
      'Duplicate observation',
    );
    expect(() =>
      analyzePolicyExperiment(plan, [{ ...values[0], key: 'unplanned' }]),
    ).toThrow('Unscheduled');
    expect(() =>
      analyzePolicyExperiment(plan, [
        { ...values[0], protocolHash: '0'.repeat(64) },
      ]),
    ).toThrow('different experiment plan');
    expect(() =>
      analyzePolicyExperiment({ ...plan, plannedLaunches: 999 }, values),
    ).toThrow('plan changed');
    expect(() => createPolicyExperiment({ contrast: 'everything' })).toThrow(
      'Choose output',
    );
    expect(() => createPolicyExperiment({ repetitions: 0 })).toThrow(
      'predeclared repetitions',
    );
  });

  it('keeps an unobserved receiving provider unmeasured when only the other direction has records', () => {
    const plan = createPolicyExperiment();
    const report = analyzePolicyExperiment(
      plan,
      observations(plan).filter((value) => value.provider === 'claude'),
    );
    expect(
      report.receivers.find((row) => row.provider === 'codex'),
    ).toMatchObject({
      recordedObservations: 0,
      cacheBenefit: 'unmeasured',
      replicatedCachePattern: false,
    });
    expect(
      report.receivers.find((row) => row.provider === 'claude')!
        .recordedObservations,
    ).toBe(4);
  });
});
