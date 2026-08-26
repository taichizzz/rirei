import { describe, expect, it } from 'vitest';
import { loadDashboardData } from '../../src/tui/state.js';

describe('TUI state loader', () => {
  it('loads dashboard data and provider plan usage without throwing', async () => {
    const data = await loadDashboardData(process.cwd());
    expect(data.currentProject).toBe(process.cwd());
    expect(data.lastUpdated).toBeDefined();
    expect(data.planUsage).toBeDefined();
    expect(typeof data.planUsage).toBe('object');
  });
});
