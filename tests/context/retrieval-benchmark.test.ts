import { describe, expect, it } from 'vitest';
import '../helpers.js';
import { retrievalBenchmark } from '../../benchmarks/continuity/retrieve.mjs';

describe('offline targeted retrieval workload', () => {
  it('retrieves the same selected source ranges with fewer returned bytes and executed read commands', async () => {
    const result = await retrievalBenchmark();
    expect(result.providerSessions).toBe(0);
    expect(result.workload).toMatchObject({
      exactSourceWindows: true,
      queryStatusesComplete: true,
      sourceStateAndJournalUnchanged: true,
    });
    expect(result.workload.baseline.calls).toBe(5);
    expect(result.workload.targeted.calls).toBe(2);
    expect(result.workload.targeted.returnedBytes).toBeLessThan(
      result.workload.baseline.returnedBytes,
    );
    expect(
      result.workload.targeted.responses[0].characters,
    ).toBeLessThanOrEqual(2000);
    expect(
      result.workload.targeted.responses[1].characters,
    ).toBeLessThanOrEqual(12000);
  });
});
