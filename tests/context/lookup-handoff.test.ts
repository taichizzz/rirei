import { describe, expect, it } from 'vitest';
import { lookupHandoffBenchmark } from '../../benchmarks/continuity/lookup-handoff.mjs';

describe('lookup-dependent benchmark handoff', () => {
  it.skipIf(process.platform === 'win32')(
    'finishes only when the receiver can read the cited evidence through the pinned helper',
    async () => {
      const result = await lookupHandoffBenchmark();
      expect(result).toMatchObject({
        providerSessions: 0,
        bareRelayShadowed: true,
        lateCorrectionInline: true,
        exactLabelInline: false,
        priorTest: { exitCode: 0, freshness: 'stale' },
        bareRelay: { acceptancePassed: false, freshVerificationExitCode: null },
        explicitHelper: {
          lookupExitCode: 0,
          exactCitedRecord: true,
          freshVerificationExitCode: 0,
          acceptancePassed: true,
        },
        sourceStateAndJournalUnchanged: true,
      });
    },
  );
});
