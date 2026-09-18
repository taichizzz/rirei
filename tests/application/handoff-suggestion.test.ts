import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentAdapter,
  AgentId,
  ProviderUsageSnapshot,
} from '../../src/agents/adapter.js';
import * as registry from '../../src/agents/registry.js';
import {
  buildHandoffOffer,
  printHandoffSuggestion,
  suggestHandoffTargets,
} from '../../src/application/handoff-suggestion.js';
import { verifySwitchPreview } from '../../src/cli/switch.js';
import { renderHandoffDocument } from '../../src/lifecycle.js';
import { inspectGitSnapshot } from '../../src/git/repository.js';
import { writeConfig } from '../../src/config/loader.js';
import { defaultConfig } from '../../src/config/schema.js';
import {
  LATEST_STATE_SCHEMA,
  type RelayState,
  type HandoffNote,
} from '../../src/state/schema.js';
import { writeState } from '../../src/state/store.js';
import { createRepository, removeRepository } from '../helpers.js';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) await removeRepository(root);
  }
});

async function setupProject(): Promise<{ root: string; state: RelayState }> {
  const root = await createRepository();
  roots.push(root);
  await mkdir(path.join(root, '.relay'), { recursive: true });
  await writeConfig(root, defaultConfig);
  const now = new Date().toISOString();
  const state: RelayState = {
    schemaVersion: LATEST_STATE_SCHEMA,
    revision: 0,
    recentOperations: [],
    sessionId: 'session-handoff',
    projectRoot: root,
    task: {
      title: 'Handoff task',
      originalRequest: 'Handoff task',
      requirements: [],
      constraints: [],
      status: 'active',
      createdAt: now,
      updatedAt: now,
    },
    git: {
      startingCommit: 'abc',
      startingBranch: 'main',
      dirtyAtStart: false,
    },
    runs: [],
    agentHistory: [],
    decisions: [],
    completedWork: [],
    remainingWork: [],
    tests: [],
    checkpoints: [],
    blockers: [],
    notes: [],
  };
  await writeState(root, state);
  return { root, state };
}

function makeMockAdapter(
  id: AgentId,
  displayName: string,
  options: {
    installed?: boolean;
    throwsInstall?: boolean;
    snapshots?: ProviderUsageSnapshot[];
    throwsUsage?: boolean;
  } = {},
): AgentAdapter {
  return {
    id,
    displayName,
    detectInstallation: async () => {
      if (options.throwsInstall) throw new Error('Detect failed');
      return {
        status: (options.installed ?? true) ? 'ready' : 'not_installed',
      };
    },
    detectAuthentication: async () => ({
      status: 'unknown',
      checkedAt: new Date().toISOString(),
      source: 'none',
      confidence: 'low',
    }),
    readUsage:
      options.snapshots !== undefined || options.throwsUsage
        ? async () => {
            if (options.throwsUsage) throw new Error('Usage read failed');
            return options.snapshots!;
          }
        : undefined,
    command: () => ({ executable: id, args: [] }),
    discoverCapabilities: async () => ({
      supportsPromptArgument: true,
      supportsModelSelection: false,
      supportsReasoningEffort: false,
      models: [],
      effortLevels: [],
    }),
  };
}

describe('handoff-suggestion', () => {
  describe('suggestHandoffTargets', () => {
    it('excludes the exhausted provider from its own suggestions', async () => {
      const { root, state } = await setupProject();
      const claude = makeMockAdapter('claude', 'Claude');
      const codex = makeMockAdapter('codex', 'Codex');

      vi.spyOn(registry, 'registeredAgents').mockReturnValue([claude, codex]);

      const suggestions = await suggestHandoffTargets(root, state, 'claude');
      expect(suggestions.map((s) => s.id)).toEqual(['codex']);
      expect(suggestions.some((s) => s.id === 'claude')).toBe(false);
    });

    it('excludes a second exhausted provider reporting 0 remaining quota', async () => {
      const { root, state } = await setupProject();
      const claude = makeMockAdapter('claude', 'Claude');
      const futureReset = new Date(Date.now() + 3600_000).toISOString();
      const codexExhausted = makeMockAdapter('codex', 'Codex', {
        snapshots: [
          {
            provider: 'codex',
            status: 'available',
            capturedAt: new Date().toISOString(),
            metrics: [
              {
                id: 'codex-quota',
                label: 'Five-hour limit',
                kind: 'quota',
                status: 'fresh',
                resetsAt: futureReset,
                remaining: 0,
                unit: 'percent',
              },
            ],
          },
        ],
      });
      const opencode = makeMockAdapter('opencode', 'OpenCode');

      vi.spyOn(registry, 'registeredAgents').mockReturnValue([
        claude,
        codexExhausted,
        opencode,
      ]);

      const suggestions = await suggestHandoffTargets(root, state, 'claude');
      expect(suggestions.map((s) => s.id)).toEqual(['opencode']);
      expect(suggestions.some((s) => s.id === 'codex')).toBe(false);
    });

    it('ranks a provider already used on this task above an unused one', async () => {
      const { root, state } = await setupProject();
      const claude = makeMockAdapter('claude', 'Claude');
      const codex = makeMockAdapter('codex', 'Codex');
      const opencode = makeMockAdapter('opencode', 'OpenCode');

      // State records opencode in agentHistory
      state.agentHistory.push({
        agent: 'opencode',
        operationId: 'op-1',
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
      });

      vi.spyOn(registry, 'registeredAgents').mockReturnValue([
        claude,
        codex,
        opencode,
      ]);

      const suggestions = await suggestHandoffTargets(root, state, 'claude');
      expect(suggestions.length).toBe(2);
      expect(suggestions[0]?.id).toBe('opencode');
      expect(suggestions[0]?.reason).toContain('Previously used on this task');
      expect(suggestions[1]?.id).toBe('codex');
      expect(suggestions[1]?.reason).toContain('Installed alternative');
    });

    it('keeps a provider with unknown usage eligible', async () => {
      const { root, state } = await setupProject();
      const claude = makeMockAdapter('claude', 'Claude');
      // gemini has no readUsage
      const gemini = makeMockAdapter('gemini', 'Gemini');

      vi.spyOn(registry, 'registeredAgents').mockReturnValue([claude, gemini]);

      const suggestions = await suggestHandoffTargets(root, state, 'claude');
      expect(suggestions.map((s) => s.id)).toEqual(['gemini']);
      expect(suggestions[0]?.reason).toBe('Installed alternative');
    });

    it('returns an empty list when no alternative adapters are installed', async () => {
      const { root, state } = await setupProject();
      const claude = makeMockAdapter('claude', 'Claude');
      const codexNotInstalled = makeMockAdapter('codex', 'Codex', {
        installed: false,
      });

      vi.spyOn(registry, 'registeredAgents').mockReturnValue([
        claude,
        codexNotInstalled,
      ]);

      const suggestions = await suggestHandoffTargets(root, state, 'claude');
      expect(suggestions).toEqual([]);
    });

    it('handles adapter error during detection or usage gracefully without crashing', async () => {
      const { root, state } = await setupProject();
      const claude = makeMockAdapter('claude', 'Claude');
      const errorAdapter = makeMockAdapter('codex', 'Codex', {
        throwsInstall: true,
      });
      const usageErrorAdapter = makeMockAdapter('opencode', 'OpenCode', {
        throwsUsage: true,
      });

      vi.spyOn(registry, 'registeredAgents').mockReturnValue([
        claude,
        errorAdapter,
        usageErrorAdapter,
      ]);

      const suggestions = await suggestHandoffTargets(root, state, 'claude');
      // errorAdapter is skipped; usageErrorAdapter stays eligible as unknown
      expect(suggestions.map((s) => s.id)).toEqual(['opencode']);
    });
  });

  describe('buildHandoffOffer', () => {
    it('warns up front when no continuation notes are recorded', async () => {
      const { root, state } = await setupProject();
      const claude = makeMockAdapter('claude', 'Claude');
      const codex = makeMockAdapter('codex', 'Codex');

      vi.spyOn(registry, 'registeredAgents').mockReturnValue([claude, codex]);
      vi.spyOn(registry, 'getAgent').mockImplementation((id) =>
        id === 'claude' ? claude : codex,
      );

      // state.notes is empty
      const offer = await buildHandoffOffer(root, state, 'claude', {
        reason: 'usage_limit',
        retryAt: '2026-09-18T16:30:00.000Z',
      });

      expect(offer).not.toBeNull();
      expect(offer?.hasContinuationNotes).toBe(false);
      expect(offer?.notesWarning).toBe(
        'No continuation notes recorded. Add one to hand off, or switch anyway.',
      );
      expect(offer?.target?.id).toBe('codex');
      expect(offer?.headline).toContain('Claude reached its usage limit');
      expect(offer?.headline).toContain('Hand off to Codex?');
    });

    it('omits notesWarning when valid continuation notes exist', async () => {
      const { root, state } = await setupProject();
      const claude = makeMockAdapter('claude', 'Claude');
      const codex = makeMockAdapter('codex', 'Codex');

      vi.spyOn(registry, 'registeredAgents').mockReturnValue([claude, codex]);
      vi.spyOn(registry, 'getAgent').mockImplementation((id) =>
        id === 'claude' ? claude : codex,
      );

      const note: HandoffNote = {
        id: '11111111-1111-4111-8111-111111111111',
        type: 'next',
        text: 'Implement remaining Phase 4 tests',
        createdAt: new Date().toISOString(),
        provenance: {
          source: 'agent',
          agent: 'Claude',
          recordedBy: 'relay-cli',
        },
        git: {
          commit: 'abc',
          branch: 'main',
          fingerprint: 'a'.repeat(64),
        },
      };
      state.notes.push(note);

      const offer = await buildHandoffOffer(root, state, 'claude', {
        reason: 'usage_limit',
      });

      expect(offer).not.toBeNull();
      expect(offer?.hasContinuationNotes).toBe(true);
      expect(offer?.notesWarning).toBeUndefined();
    });

    it('handles suggestion lookup failures safely without crashing', async () => {
      const { root, state } = await setupProject();
      vi.spyOn(registry, 'registeredAgents').mockImplementation(() => {
        throw new Error('Registry corrupted');
      });

      const offer = await buildHandoffOffer(root, state, 'claude', {
        reason: 'usage_limit',
      });

      expect(offer).not.toBeNull();
      expect(offer?.target).toBeUndefined();
      expect(offer?.otherTargets).toEqual([]);
      expect(offer?.headline).toContain('Claude reached its usage limit.');
    });
  });

  describe('printHandoffSuggestion', () => {
    it('prints formatted suggestion to stderr', async () => {
      const { root, state } = await setupProject();
      const claude = makeMockAdapter('claude', 'Claude');
      const codex = makeMockAdapter('codex', 'Codex');

      vi.spyOn(registry, 'registeredAgents').mockReturnValue([claude, codex]);
      vi.spyOn(registry, 'getAgent').mockImplementation((id) =>
        id === 'claude' ? claude : codex,
      );

      const stdoutSpy = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation(() => true);

      await printHandoffSuggestion(root, state, 'claude', {
        reason: 'usage_limit',
      });

      expect(stdoutSpy).toHaveBeenCalled();
      const combinedOutput = stdoutSpy.mock.calls
        .map(([chunk]) => String(chunk))
        .join('');
      expect(combinedOutput).toContain('Claude reached its usage limit');
      expect(combinedOutput).toContain('relay switch codex');
      expect(combinedOutput).toContain('No continuation notes recorded');
    });
  });

  describe('switch flow safeguards', () => {
    it('verifySwitchPreview rejects if Git or state changes between preview and switch', async () => {
      const { root, state } = await setupProject();
      const snapshot = await inspectGitSnapshot(root, 1);
      const preview = await renderHandoffDocument(root, state, root, snapshot);

      // Verify clean preview passes
      const verifiedState = await verifySwitchPreview(root, preview);
      expect(verifiedState.sessionId).toBe(state.sessionId);

      // Now modify git repository
      await writeFile(path.join(root, 'README.md'), '# Test\nModified\n');

      // verifySwitchPreview must reject because git state changed
      await expect(verifySwitchPreview(root, preview)).rejects.toThrow(
        /Handoff-relevant state or Git changed after the preview/,
      );
    });
  });
});
