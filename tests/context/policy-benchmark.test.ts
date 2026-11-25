import { describe, expect, it } from 'vitest';
import '../helpers.js';
import { policyBenchmark } from '../../benchmarks/continuity/policies.mjs';

describe('offline profile qualification workload', () => {
  it('preserves requirements and uncertainty across all profiles without inventing usage or cache observations', async () => {
    const report = await policyBenchmark();
    expect(report.providerSessions).toBe(0);
    expect(report.analysis.recordedObservations).toBe(0);
    expect(report.profiles).toHaveLength(4);
    for (const row of report.profiles) {
      expect(row.profiles.map((profile) => profile.profile)).toEqual([
        'control',
        'focused-output',
        'stable-layout',
        'stable-focused',
      ]);
      for (const profile of row.profiles) {
        expect(profile).toMatchObject({
          exactRequirementsInline: 6,
          selectedEvidenceUnchanged: true,
          coverageWarningsUnchanged: true,
          applied: true,
        });
        expect(profile.outputTokens).toBeNull();
        expect(profile.cacheReadTokens).toBeNull();
        expect(profile.receiverWallTimeMs).toBeNull();
      }
      const prefixes = row.runtimeMetadataProbe;
      expect(
        prefixes.every(
          (probe) =>
            probe.sameSelectedEvidence &&
            probe.captureMetadataChanged &&
            probe.sharedPromptPrefix.providerCacheReuse === null,
        ),
      ).toBe(true);
      expect(
        prefixes.find((probe) => probe.profile === 'stable-layout')!
          .sharedPromptPrefix.utf8Bytes,
      ).toBeGreaterThan(
        prefixes.find((probe) => probe.profile === 'control')!
          .sharedPromptPrefix.utf8Bytes,
      );
    }
    expect(report.proposedExperiment).toMatchObject({
      authorizedLaunches: 0,
      plannedLaunches: 8,
    });
    expect(
      report.analysis.receivers.every(
        (receiver) => receiver.cacheBenefit === 'unmeasured',
      ),
    ).toBe(true);
  });
});
