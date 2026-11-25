import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { RECEIVER_OUTPUT_POLICY } from '../../src/context/prompt-policy.ts';
import { ProviderMeasurement } from './measurement.mjs';
import { parseJsonLines } from '../handoff/lib.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const contrasts = {
  output: 'focused-output',
  layout: 'stable-layout',
  combined: 'stable-focused',
};
const cases = [
  { index: 0, task: 'tenant-ledger', receiver: 'codex' },
  { index: 1, task: 'cursor-feed', receiver: 'claude' },
  { index: 2, task: 'cursor-feed', receiver: 'codex' },
  { index: 3, task: 'tenant-ledger', receiver: 'claude' },
];

/** Planning only. This module has no process-launch or cache/credential mutation path. */
export function createPolicyExperiment({
  contrast = 'output',
  repetitions = 1,
  sourceHashes = {},
} = {}) {
  assert.ok(
    Object.hasOwn(contrasts, contrast),
    'Choose output, layout, or combined.',
  );
  assert.ok(
    Number.isSafeInteger(repetitions) && repetitions >= 1 && repetitions <= 3,
    'Use one to three predeclared repetitions.',
  );
  const schedule = [];
  for (let repetition = 0; repetition < repetitions; repetition++) {
    const seen = { claude: 0, codex: 0 };
    for (const row of cases) {
      const order =
        (seen[row.receiver]++ + repetition) % 2 === 0
          ? ['control', contrasts[contrast]]
          : [contrasts[contrast], 'control'];
      for (const [position, profile] of order.entries())
        schedule.push({
          key: `${contrast}/r${repetition}/c${row.index}/${profile}`,
          pairId: `r${repetition}/c${row.index}`,
          repetition,
          caseIndex: row.index,
          task: row.task,
          receiver: row.receiver,
          position,
          profile,
        });
    }
  }
  const body = {
    schemaVersion: 1,
    mode: 'policy-cache-experiment-plan',
    contrast,
    profiles: ['control', contrasts[contrast]],
    repetitions,
    plannedLaunches: schedule.length,
    authorizedLaunches: 0,
    automaticReruns: 0,
    orderPolicy:
      'AB/BA across the two tasks within each receiver; invert order on each repetition',
    cacheCondition: 'uncontrolled',
    mutateProviderCaches: false,
    mutateCredentials: false,
    currentRuntimeVersions: { claude: null, codex: null },
    runtimeRequirement:
      'Record CLI version, requested/resolved model where exposed, effort, start/end times, and actual elapsed spacing for every fresh session.',
    usageRequirement:
      'Keep total input, cache read, cache creation, output, and reasoning separate; absent counters stay null and output-inclusive reasoning is not added twice.',
    outputPolicySha256: hash(RECEIVER_OUTPUT_POLICY),
    sourceHashes: Object.fromEntries(
      Object.entries(sourceHashes).sort(([a], [b]) => a.localeCompare(b)),
    ),
    schedule,
  };
  return { ...body, hash: hash(JSON.stringify(body)) };
}

const nullableCounter = z.number().finite().nonnegative().nullable();
const observationSchema = z
  .object({
    protocolHash: z.string().regex(/^[a-f0-9]{64}$/),
    key: z.string().min(1).max(200),
    provider: z.enum(['claude', 'codex']),
    cliVersion: z.string().min(1).max(100).nullable(),
    requestedModel: z.string().min(1).max(256).nullable(),
    effort: z.string().min(1).max(40).nullable(),
    actualModel: z.string().min(1).max(256).nullable().default(null),
    startedAt: z.iso.datetime().nullable(),
    endedAt: z.iso.datetime().nullable(),
    wallTimeMs: nullableCounter,
    status: z.enum([
      'completed',
      'failed',
      'infrastructure-affected',
      'unresolved',
    ]),
    acceptancePassed: z.boolean().nullable(),
    strictSuccess: z.boolean().nullable(),
    traceComplete: z.boolean(),
    policyApplied: z.boolean(),
    visibleJsonl: z.string().max(16 * 1024 * 1024),
  })
  .strict();
const metricNames = [
  'inputTokens',
  'cachedInputTokens',
  'cacheCreationInputTokens',
  'outputTokens',
  'reasoningTokens',
  'nonCachedTokens',
  'toolCalls',
  'modelTurns',
];
const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

function normalizeObservation(value, expected, protocolHash) {
  const observation = observationSchema.parse(value);
  assert.equal(
    observation.protocolHash,
    protocolHash,
    'Observation belongs to a different experiment plan or source version.',
  );
  assert.equal(
    observation.provider,
    expected.receiver,
    'Observation provider differs from its scheduled receiver.',
  );
  const measurement = new ProviderMeasurement(observation.provider);
  for (const record of parseJsonLines(observation.visibleJsonl))
    measurement.observe(record);
  const measured = measurement.metrics();
  const metrics = Object.fromEntries(
    metricNames.map((name) => [
      name,
      Number.isSafeInteger(measured[name]) && measured[name] >= 0
        ? measured[name]
        : null,
    ]),
  );
  if (
    metrics.inputTokens !== null &&
    metrics.cachedInputTokens > metrics.inputTokens
  ) {
    metrics.cachedInputTokens = null;
    metrics.nonCachedTokens = null;
  }
  const actualModel = measured.actualModel ?? observation.actualModel;
  return {
    key: observation.key,
    provider: observation.provider,
    cliVersion: observation.cliVersion,
    requestedModel: observation.requestedModel,
    effort: observation.effort,
    actualModel,
    runtimeConflict: Boolean(
      measured.actualModel &&
      observation.actualModel &&
      measured.actualModel !== observation.actualModel,
    ),
    providerReportedError:
      measurement.providerError || measurement.final?.is_error === true,
    startedAt: observation.startedAt,
    endedAt: observation.endedAt,
    wallTimeMs: observation.wallTimeMs,
    status: observation.status,
    acceptancePassed: observation.acceptancePassed,
    strictSuccess: observation.strictSuccess,
    traceComplete: observation.traceComplete,
    policyApplied: observation.policyApplied,
    metrics,
    traceSha256: hash(observation.visibleJsonl),
    cacheCountersExposed: {
      read: metrics.cachedInputTokens !== null,
      creation: metrics.cacheCreationInputTokens !== null,
    },
  };
}

/** Descriptive saved-observation analysis; a longer common byte prefix is never a cache hit. */
export function analyzePolicyExperiment(protocol, values = []) {
  const { hash: protocolHash, ...body } = protocol;
  assert.equal(
    hash(JSON.stringify(body)),
    protocolHash,
    'Experiment plan changed.',
  );
  const regenerated = createPolicyExperiment({
    contrast: protocol.contrast,
    repetitions: protocol.repetitions,
    sourceHashes: protocol.sourceHashes,
  });
  assert.deepEqual(protocol, regenerated, 'Experiment plan is not canonical.');
  assert.ok(
    Array.isArray(values) && values.length <= protocol.plannedLaunches,
    'Too many observations for the planned schedule.',
  );
  const byKey = new Map();
  for (const value of values) {
    const expected = protocol.schedule.find((row) => row.key === value.key);
    assert.ok(expected, 'Unscheduled observation.');
    assert.ok(
      !byKey.has(value.key),
      'Duplicate observation; retries cannot replace a consumed key.',
    );
    byKey.set(value.key, normalizeObservation(value, expected, protocolHash));
  }
  const pairs = [];
  for (const first of protocol.schedule.filter((row) => row.position === 0)) {
    const planned = protocol.schedule.filter(
      (row) => row.pairId === first.pairId,
    );
    const control = byKey.get(
      planned.find((row) => row.profile === 'control').key,
    );
    const candidate = byKey.get(
      planned.find((row) => row.profile !== 'control').key,
    );
    const reasons = [];
    for (const [name, observed] of [
      ['control', control],
      ['candidate', candidate],
    ]) {
      if (!observed) {
        reasons.push(`${name}-missing`);
        continue;
      }
      if (
        observed.status !== 'completed' ||
        observed.acceptancePassed !== true ||
        observed.strictSuccess !== true ||
        !observed.traceComplete
      )
        reasons.push(`${name}-not-strict-acceptance-success`);
      if (observed.runtimeConflict) reasons.push(`${name}-runtime-conflict`);
      if (observed.providerReportedError)
        reasons.push(`${name}-provider-reported-error`);
      if (!observed.cliVersion || !observed.requestedModel || !observed.effort)
        reasons.push(`${name}-runtime-unknown`);
    }
    if (candidate && !candidate.policyApplied)
      reasons.push('candidate-profile-fell-back');
    if (
      control &&
      candidate &&
      ['cliVersion', 'requestedModel', 'effort', 'actualModel'].some(
        (name) => control[name] !== candidate[name],
      )
    )
      reasons.push('receiver-runtime-mismatch');
    let elapsedSpacingMs = null;
    const firstObserved = byKey.get(planned[0].key);
    const secondObserved = byKey.get(planned[1].key);
    if (
      firstObserved?.startedAt &&
      firstObserved.endedAt &&
      secondObserved?.startedAt &&
      secondObserved.endedAt
    ) {
      elapsedSpacingMs =
        Date.parse(secondObserved.startedAt) -
        Date.parse(firstObserved.endedAt);
      if (
        Date.parse(firstObserved.endedAt) <
          Date.parse(firstObserved.startedAt) ||
        Date.parse(secondObserved.endedAt) <
          Date.parse(secondObserved.startedAt) ||
        elapsedSpacingMs < 0
      )
        reasons.push('observed-order-or-timing-mismatch');
    } else reasons.push('observed-spacing-unknown');
    const qualified = reasons.length === 0;
    const differences = Object.fromEntries(
      [...metricNames, 'wallTimeMs'].map((name) => {
        const a =
          name === 'wallTimeMs' ? control?.wallTimeMs : control?.metrics[name];
        const b =
          name === 'wallTimeMs'
            ? candidate?.wallTimeMs
            : candidate?.metrics[name];
        return [
          name,
          qualified && Number.isFinite(a) && Number.isFinite(b) ? b - a : null,
        ];
      }),
    );
    const fraction = (observation) =>
      observation?.metrics.inputTokens > 0 &&
      observation.metrics.cachedInputTokens !== null
        ? observation.metrics.cachedInputTokens /
          observation.metrics.inputTokens
        : null;
    const a = fraction(control);
    const b = fraction(candidate);
    const cacheReadFractionDelta =
      qualified && a !== null && b !== null ? b - a : null;
    const cachePositiveWithoutMeasuredRegressions =
      qualified &&
      cacheReadFractionDelta > 0 &&
      differences.cachedInputTokens > 0 &&
      ['nonCachedTokens', 'outputTokens', 'toolCalls', 'wallTimeMs'].every(
        (name) => differences[name] !== null && differences[name] <= 0,
      );
    pairs.push({
      pairId: first.pairId,
      caseIndex: first.caseIndex,
      receiver: first.receiver,
      repetition: first.repetition,
      plannedOrder: planned.map((row) => row.profile),
      qualified,
      reasons,
      elapsedSpacingMs,
      modelQualification: qualified
        ? control.actualModel
          ? 'resolved-model'
          : 'requested-model-only'
        : 'unqualified',
      control: control ? { ...control } : null,
      candidate: candidate ? { ...candidate } : null,
      differences,
      cacheReadFractionDelta,
      cachePositiveWithoutMeasuredRegressions,
    });
  }
  const receivers = ['claude', 'codex'].map((provider) => {
    const observed = [...byKey.values()].filter(
      (row) => row.provider === provider,
    ).length;
    const rows = pairs.filter((pair) => pair.receiver === provider);
    const qualified = rows.filter((pair) => pair.qualified);
    const runtimeGroups = new Set(
      qualified.map((pair) =>
        JSON.stringify([
          pair.control.cliVersion,
          pair.control.requestedModel,
          pair.control.effort,
          pair.control.actualModel,
        ]),
      ),
    );
    const complete = qualified.length === rows.length && rows.length > 0;
    const stableRuntime = qualified.length > 0 && runtimeGroups.size === 1;
    const balancedOrders =
      qualified.some((pair) => pair.plannedOrder[0] === 'control') &&
      qualified.some((pair) => pair.plannedOrder[0] !== 'control');
    const replicatedCases = cases
      .filter((row) => row.receiver === provider)
      .every(
        (row) =>
          qualified.filter((pair) => pair.caseIndex === row.index).length >= 2,
      );
    const replicatedCachePattern =
      complete &&
      stableRuntime &&
      balancedOrders &&
      replicatedCases &&
      qualified.every((pair) => pair.cachePositiveWithoutMeasuredRegressions);
    return {
      provider,
      recordedObservations: observed,
      plannedPairs: rows.length,
      qualifiedPairs: qualified.length,
      excludedPairs: rows.length - qualified.length,
      stableRuntime,
      allPairsQualified: complete,
      balancedObservedOrder: complete && balancedOrders,
      replicatedCases,
      replicatedCachePattern,
      cacheBenefit: !observed
        ? 'unmeasured'
        : replicatedCachePattern
          ? 'descriptive-replicated-counter-pattern'
          : 'not-qualified',
      medianPairedDifferences: Object.fromEntries(
        [...metricNames, 'wallTimeMs'].map((name) => [
          name,
          stableRuntime
            ? median(
                qualified
                  .map((pair) => pair.differences[name])
                  .filter((value) => value !== null),
              )
            : null,
        ]),
      ),
      metricPairs: Object.fromEntries(
        [...metricNames, 'wallTimeMs'].map((name) => [
          name,
          stableRuntime
            ? qualified.filter((pair) => pair.differences[name] !== null).length
            : 0,
        ]),
      ),
    };
  });
  return {
    schemaVersion: 1,
    mode: 'saved-policy-observation-analysis',
    protocolHash,
    recordedObservations: values.length,
    providerSessionsLaunched: 0,
    pairs,
    receivers,
    recommendation:
      'No automatic promotion. Review correctness, all-attempt validity, counter coverage, output/tools/latency, and provider-specific replication.',
    limitations: [
      'Exact prompt-prefix equality is not a provider cache measurement. Provider-managed cache state remains uncontrolled.',
      'Reasoning exposed as part of output is reported separately and is not added again to output or non-cached usage.',
      'Descriptive replication does not establish significance or a controlled cold-cache comparison.',
    ],
  };
}
