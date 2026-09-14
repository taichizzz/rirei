import { describe, expect, it, vi } from 'vitest';
import { startTuiAgent } from '../../src/cli/tui.js';

const selection = {
  agent: 'opencode',
  model: 'test-model',
};

describe('TUI agent workspace selection', () => {
  it('uses the main working tree when it is available', async () => {
    const start = vi
      .fn()
      .mockResolvedValue({ id: 'terminal-1', status: 'starting' });
    const createWorkspace = vi.fn();

    await startTuiAgent({ start }, selection, '/repo', createWorkspace);

    expect(start).toHaveBeenCalledWith({
      kind: 'agent',
      agent: 'opencode',
      model: 'test-model',
      effort: undefined,
      project: '/repo',
      workspaceId: 'default',
    });
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  it('creates an isolated workspace when the main tree is claimed', async () => {
    const start = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('claimed'), { code: 'claimed' }),
      )
      .mockResolvedValueOnce({ id: 'terminal-2', status: 'starting' });
    const createWorkspace = vi.fn().mockResolvedValue({
      id: 'workspace-2',
      branch: 'rirei/task-implement-2',
    });

    await startTuiAgent({ start }, selection, '/repo', createWorkspace);

    expect(createWorkspace).toHaveBeenCalledOnce();
    expect(start).toHaveBeenLastCalledWith({
      kind: 'agent',
      agent: 'opencode',
      model: 'test-model',
      effort: undefined,
      project: '/repo',
      workspaceId: 'workspace-2',
      branchLabel: 'rirei/task-implement-2',
    });
  });

  it('does not create a workspace for unrelated launch failures', async () => {
    const failure = Object.assign(new Error('capacity'), { code: 'capacity' });
    const start = vi.fn().mockRejectedValue(failure);
    const createWorkspace = vi.fn();

    await expect(
      startTuiAgent({ start }, selection, '/repo', createWorkspace),
    ).rejects.toBe(failure);
    expect(createWorkspace).not.toHaveBeenCalled();
  });
});
