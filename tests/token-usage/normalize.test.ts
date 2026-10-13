import { describe, expect, it } from 'vitest';
import {
  deriveReportFromCache,
  normalizeAgentDailyOutput,
  normalizeAgentSessionOutput,
  reconcileComponents,
  sanitizeProjectLabel,
} from '../../src/token-usage/normalize.js';
import { assertPrivacySafe } from '../../src/token-usage/privacy.js';
import type {
  AgentCacheSnapshot,
  TokenUsageCache,
} from '../../src/token-usage/schema.js';
import {
  calculateHistoryWindow,
  calculateRangeWindow,
  generateDateSequence,
  getLocalToday,
  shiftDateString,
} from '../../src/token-usage/timezone.js';

describe('token usage normalizer, reconciliation, and privacy', () => {
  describe('sanitizeProjectLabel (privacy gate)', () => {
    it('reduces Claude-style path-encoded project identifiers to basenames', () => {
      expect(
        sanitizeProjectLabel('-Users-alice-Documents-my-awesome-project'),
      ).toBe('my-awesome-project');
      expect(sanitizeProjectLabel('-Users-bob-Projects-frontend-app')).toBe(
        'frontend-app',
      );
      expect(sanitizeProjectLabel('-home-carol-code-todo-api')).toBe(
        'todo-api',
      );
      expect(
        sanitizeProjectLabel('-Users-taichizzz-Documents-New-OpenCode-Project'),
      ).toBe('New-OpenCode-Project');
    });

    it('extracts basenames from standard POSIX and Windows paths', () => {
      expect(sanitizeProjectLabel('/Users/developer/code/rirei')).toBe('rirei');
      expect(
        sanitizeProjectLabel('C:\\Users\\developer\\Projects\\workflow-engine'),
      ).toBe('workflow-engine');
      expect(sanitizeProjectLabel('/var/tmp/scratch')).toBe('scratch');
    });

    it('returns "—" for empty, null, or OpenCode sessions with no project info', () => {
      expect(sanitizeProjectLabel('')).toBe('—');
      expect(sanitizeProjectLabel('   ')).toBe('—');
      expect(sanitizeProjectLabel(null)).toBe('—');
      expect(sanitizeProjectLabel(undefined)).toBe('—');
    });

    it('guarantees no detected username appears in the sanitized label', () => {
      const currentUsername =
        process.env.USER || process.env.USERNAME || 'taichizzz';
      const rawWithUser = `-Users-${currentUsername}-Documents-secret-project`;
      const sanitized = sanitizeProjectLabel(rawWithUser);

      expect(sanitized.toLowerCase()).not.toContain(
        currentUsername.toLowerCase(),
      );
      expect(sanitized).toBe('secret-project');
    });
  });

  describe('strict validation with real output shapes', () => {
    it('accepts real Codex daily output with models object and reasoningOutputTokens', () => {
      const codexFixture = {
        daily: [
          {
            date: '2026-09-02',
            inputTokens: 48068,
            cacheCreationTokens: 0,
            cacheReadTokens: 415744,
            outputTokens: 2715,
            reasoningOutputTokens: 796,
            totalTokens: 466527,
            models: {
              'gpt-5.6-sol': {
                inputTokens: 48068,
                cacheCreationTokens: 0,
                cacheReadTokens: 415744,
                outputTokens: 2715,
                reasoningOutputTokens: 796,
                totalTokens: 466527,
                isFallback: false,
              },
            },
          },
        ],
        totals: {
          inputTokens: 48068,
          cacheCreationTokens: 0,
          cacheReadTokens: 415744,
          outputTokens: 2715,
          reasoningOutputTokens: 796,
          totalTokens: 466527,
        },
      };

      const result = normalizeAgentDailyOutput('codex', codexFixture);
      expect(result.totals.totalTokens).toBe(466527);
      expect(result.totals.components?.reasoning).toBe(796);
      expect(result.totals.components?.output).toBe(2715);
      // Arithmetic reconciles: 48068 + 0 + 415744 + 2715 = 466527
      expect(result.totals.itemized).toBe(true);
      expect(result.models).toEqual([
        { model: 'gpt-5.6-sol', totalTokens: 466527 },
      ]);
    });

    it('accepts real Claude daily output with modelBreakdowns array', () => {
      const claudeFixture = {
        daily: [
          {
            date: '2026-09-11',
            inputTokens: 236,
            cacheCreationTokens: 781846,
            cacheReadTokens: 15796643,
            outputTokens: 79546,
            totalTokens: 16658271,
            modelsUsed: ['claude-sonnet-5'],
            modelBreakdowns: [
              {
                modelName: 'claude-sonnet-5',
                inputTokens: 236,
                cacheCreationTokens: 781846,
                cacheReadTokens: 15796643,
                outputTokens: 79546,
              },
            ],
          },
        ],
        totals: {
          inputTokens: 236,
          cacheCreationTokens: 781846,
          cacheReadTokens: 15796643,
          outputTokens: 79546,
          totalTokens: 16658271,
        },
      };

      const result = normalizeAgentDailyOutput('claude', claudeFixture);
      expect(result.totals.totalTokens).toBe(16658271);
      // Claude arithmetic reconciles
      expect(result.totals.itemized).toBe(true);
      // Claude has no reasoning tokens
      expect(result.totals.components?.reasoning).toBeUndefined();
      expect(result.models).toEqual([
        { model: 'claude-sonnet-5', totalTokens: 16658271 },
      ]);
    });

    it('reconciles parts against the total with a small remainder allowance', () => {
      expect(reconcileComponents(100, 100)).toEqual({
        itemized: true,
        unitemizedTokens: 0,
      });
      // Parts 0.5% short: still a breakdown, gap reported as a remainder
      expect(reconcileComponents(995, 1000)).toEqual({
        itemized: true,
        unitemizedTokens: 5,
      });
      // Parts exceed the total: not a breakdown at all
      expect(reconcileComponents(1001, 1000)).toEqual({
        itemized: false,
        unitemizedTokens: 1000,
      });
      // Parts 2% short: gap too large to call a breakdown
      expect(reconcileComponents(980, 1000)).toEqual({
        itemized: false,
        unitemizedTokens: 1000,
      });
    });

    it('itemizes OpenCode with a remainder when parts fall slightly short of totalTokens', () => {
      // Real OpenCode data where totalTokens is canonical but components differ
      const opencodeFixture = {
        daily: [
          {
            date: '2026-09-15',
            inputTokens: 5130441,
            cacheCreationTokens: 0,
            cacheReadTokens: 39735153,
            outputTokens: 93525,
            totalTokens: 45084147, // sum of components is 44959119 != 45084147
            modelsUsed: ['gpt-5.6-sol'],
            modelBreakdowns: [
              {
                modelName: 'gpt-5.6-sol',
                inputTokens: 5130441,
                cacheCreationTokens: 0,
                cacheReadTokens: 39735153,
                outputTokens: 93525,
              },
            ],
          },
        ],
        totals: {
          inputTokens: 5130441,
          cacheCreationTokens: 0,
          cacheReadTokens: 39735153,
          outputTokens: 93525,
          totalTokens: 45084147,
        },
      };

      const result = normalizeAgentDailyOutput('opencode', opencodeFixture);
      expect(result.totals.totalTokens).toBe(45084147);
      // 125,028 short of the total is 0.28%: a breakdown plus a remainder
      expect(result.totals.itemized).toBe(true);
      expect(result.daily[0]!.models).toEqual([
        { model: 'gpt-5.6-sol', totalTokens: 44959119 },
      ]);
    });

    it('rejects missing canonical totals instead of reading them as zero', () => {
      const noTotals = {
        daily: [{ date: '2026-09-30', inputTokens: 500 }],
        totals: {},
      };
      for (const id of ['claude', 'codex', 'opencode'] as const) {
        expect(() => normalizeAgentDailyOutput(id, noTotals)).toThrow(
          'INVALID_OUTPUT',
        );
      }
      expect(() =>
        normalizeAgentSessionOutput('claude', {
          sessions: [{ sessionId: 's1', inputTokens: 5 }],
        }),
      ).toThrow('INVALID_OUTPUT');
    });

    it('keeps a missing component unknown so the gap is not broken down', () => {
      const result = normalizeAgentDailyOutput('claude', {
        daily: [
          {
            date: '2026-09-30',
            inputTokens: 900,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            totalTokens: 1000,
          },
        ],
        totals: { totalTokens: 1000 },
      });
      const day = result.daily[0]!;
      expect(day.components).toEqual({
        input: 900,
        cacheCreation: 0,
        cacheRead: 0,
      });
      expect(day.components?.output).toBeUndefined();
      // 10% of the total is unaccounted for: too much to call a breakdown
      expect(result.totals.itemized).toBe(false);
    });

    it('rejects malformed daily shapes throwing INVALID_OUTPUT', () => {
      expect(() =>
        normalizeAgentDailyOutput('codex', { invalid: true }),
      ).toThrow('INVALID_OUTPUT');

      expect(() =>
        normalizeAgentDailyOutput('claude', { daily: 'not an array' }),
      ).toThrow('INVALID_OUTPUT');
    });

    it('sanitizes session output and assigns "—" when project is missing', () => {
      const opencodeSessionFixture = {
        sessions: [
          {
            sessionId: 'ses_0af997076ffejQyYoIqnsDxpUW',
            inputTokens: 1704839,
            cacheCreationTokens: 0,
            cacheReadTokens: 12732288,
            outputTokens: 27278,
            totalTokens: 14503962,
            modelsUsed: ['gpt-6-astra'],
          },
        ],
      };

      const result = normalizeAgentSessionOutput(
        'opencode',
        opencodeSessionFixture,
      );
      expect(result).toHaveLength(1);
      expect(result[0]!.projectLabel).toBe('—');
      expect(result[0]!.totalTokens).toBe(14503962);
      // OpenCode records no session time; one must never be invented
      expect(result[0]!.lastActivity).toBeUndefined();
    });
  });

  describe('per-range coverage, stale captures, and range filtering', () => {
    // Earliest log dates seen on a real machine
    const EARLIEST = {
      claude: '2026-05-20',
      codex: '2026-05-05',
      antigravity: '2026-07-13',
      opencode: '2026-07-11',
    } as const;
    const TZ = 'Asia/Taipei';

    function snap(
      agentId: AgentCacheSnapshot['agentId'],
      earliestDate: string | null,
      capturedAt: string,
      extra: Partial<AgentCacheSnapshot> = {},
    ): AgentCacheSnapshot {
      const daily = earliestDate
        ? [
            {
              date: earliestDate,
              totalTokens: 1000,
              components: { input: 1000 },
            },
          ]
        : [];
      return {
        agentId,
        capturedAt,
        status: 'available',
        // Stored coverage is judged against the 180-day window, not a range
        coverage: { complete: earliestDate == null, earliestDate },
        totalTokens: daily.length ? 1000 : 0,
        itemized: true,
        daily,
        models: [],
        sessions: [],
        sessionCount: 0,
        ...extra,
      };
    }

    function realCache(capturedAt: string): TokenUsageCache {
      return {
        schemaVersion: 1,
        timezone: TZ,
        updatedAt: capturedAt,
        agents: {
          claude: snap('claude', EARLIEST.claude, capturedAt),
          codex: snap('codex', EARLIEST.codex, capturedAt),
          gemini: snap('gemini', null, capturedAt),
          antigravity: snap('antigravity', EARLIEST.antigravity, capturedAt),
          opencode: snap('opencode', EARLIEST.opencode, capturedAt),
        },
      };
    }

    const now = new Date('2026-09-29T04:00:00Z');
    const partialIds = (days: number) =>
      deriveReportFromCache(realCache(now.toISOString()), {
        days,
        timezone: TZ,
        now,
      })
        .agents.filter((a) => !a.coverage.complete)
        .map((a) => a.id);

    it('measures coverage against the selected range, not the 180-day window', () => {
      expect(partialIds(7)).toEqual([]);
      expect(partialIds(30)).toEqual([]);
      // 90D starts 2026-07-02: only agents whose logs start later are partial
      expect(partialIds(90)).toEqual(['antigravity', 'opencode']);
    });

    it('labels an agent with no logs as no activity, not partial', () => {
      const report = deriveReportFromCache(realCache(now.toISOString()), {
        days: 90,
        timezone: TZ,
        now,
      });
      const gemini = report.agents.find((a) => a.id === 'gemini')!;
      expect(gemini.coverage.noActivity).toBe(true);
      expect(gemini.coverage.complete).toBe(true);
      const claude = report.agents.find((a) => a.id === 'claude')!;
      expect(claude.coverage.noActivity).toBeUndefined();
    });

    it('names every agent whose logs miss the previous window in the comparison reason', () => {
      const report = deriveReportFromCache(realCache(now.toISOString()), {
        days: 90,
        timezone: TZ,
        now,
      });
      expect(report.comparison?.supported).toBe(false);
      const reason = report.comparison?.reason ?? '';
      for (const name of ['Claude', 'Codex', 'Antigravity', 'OpenCode']) {
        expect(reason).toContain(name);
      }
      expect(reason).not.toContain('Gemini');

      const report30 = deriveReportFromCache(realCache(now.toISOString()), {
        days: 30,
        timezone: TZ,
        now,
      });
      expect(report30.comparison?.supported).toBe(true);
    });

    it('marks days after an old capture as not collected instead of zero', () => {
      // Captured 2026-09-24 17:00 in Taipei; viewed five days later
      const report = deriveReportFromCache(
        realCache('2026-09-24T09:00:00.000Z'),
        { days: 7, timezone: TZ, now },
      );
      expect(report.range.until).toBe('2026-09-29');
      expect(report.dataThrough).toBe('2026-09-24');
      expect(report.isPartial).toBe(true);
      for (const a of report.agents) {
        expect(a.coverage.dataThrough).toBe('2026-09-24');
      }
      expect(report.comparison?.supported).toBe(false);
      expect(report.comparison?.reason).toContain('Sep 24');
    });

    it('limits models and sessions to the selected range', () => {
      const capturedAt = now.toISOString();
      const claude = snap('claude', '2026-08-01', capturedAt, {
        daily: [
          {
            date: '2026-08-01',
            totalTokens: 500,
            components: { input: 500 },
            models: [{ model: 'old-model', totalTokens: 500 }],
          },
          {
            date: '2026-09-28',
            totalTokens: 300,
            components: { input: 300 },
            models: [{ model: 'new-model', totalTokens: 300 }],
          },
        ],
        sessions: [
          {
            agent: 'claude',
            projectLabel: 'recent',
            models: ['new-model'],
            totalTokens: 300,
            lastActivity: '2026-09-28T03:00:00.000Z',
          },
          {
            agent: 'claude',
            projectLabel: 'old',
            models: ['old-model'],
            totalTokens: 500,
            lastActivity: '2026-08-01T03:00:00.000Z',
          },
        ],
        sessionCount: 2,
      });
      const opencode = snap('opencode', '2026-09-28', capturedAt, {
        sessions: [
          {
            agent: 'opencode',
            projectLabel: '—',
            models: [],
            totalTokens: 10,
          },
        ],
        sessionCount: 1,
      });
      const cache: TokenUsageCache = {
        schemaVersion: 1,
        timezone: TZ,
        updatedAt: capturedAt,
        agents: {
          claude,
          codex: undefined,
          gemini: undefined,
          antigravity: undefined,
          opencode,
        },
      };

      const report = deriveReportFromCache(cache, {
        days: 7,
        timezone: TZ,
        now,
      });
      const claudeReport = report.agents.find((a) => a.id === 'claude')!;
      expect(claudeReport.models).toEqual([
        { model: 'new-model', totalTokens: 300 },
      ]);
      expect(claudeReport.sessions).toBe(1);
      expect(report.sessions.map((s) => s.projectLabel)).toEqual(['recent']);

      const opencodeReport = report.agents.find((a) => a.id === 'opencode')!;
      expect(opencodeReport.sessions).toBe(0);
      expect(opencodeReport.sessionsUntimed).toBe(1);
    });

    it('reports a small remainder as not broken down and keeps parts plus remainder equal to the total', () => {
      const capturedAt = now.toISOString();
      const cache: TokenUsageCache = {
        schemaVersion: 1,
        timezone: TZ,
        updatedAt: capturedAt,
        agents: {
          claude: undefined,
          codex: undefined,
          gemini: undefined,
          antigravity: undefined,
          opencode: snap('opencode', '2026-09-28', capturedAt, {
            daily: [
              {
                date: '2026-09-28',
                totalTokens: 1000,
                components: { input: 400, cacheRead: 598 },
              },
            ],
          }),
        },
      };
      const report = deriveReportFromCache(cache, {
        days: 7,
        timezone: TZ,
        now,
      });
      const oc = report.agents.find((a) => a.id === 'opencode')!;
      expect(oc.itemized).toBe(true);
      expect(oc.unitemizedTokens).toBe(2);
      const c = report.totals!.components!;
      expect(
        (c.input ?? 0) +
          (c.cacheRead ?? 0) +
          (c.cacheCreation ?? 0) +
          (c.output ?? 0) +
          (report.totals!.unitemizedTokens ?? 0),
      ).toBe(report.totals!.totalTokens);
    });

    it('keeps a 13-week Monday-aligned calendar whatever the range', () => {
      const report = deriveReportFromCache(realCache(now.toISOString()), {
        days: 7,
        timezone: TZ,
        now,
      });
      const cal = report.calendar!;
      expect(cal.until).toBe('2026-09-29');
      expect(new Date(`${cal.since}T00:00:00Z`).getUTCDay()).toBe(1);
      const len = generateDateSequence(cal.since, cal.until).length;
      expect(len).toBeGreaterThan(84);
      expect(len).toBeLessThanOrEqual(91);
    });
  });

  describe('deriveReportFromCache & failure semantics', () => {
    it('returns null totals and lists all agents missing when no agent succeeds', () => {
      const emptyCache: TokenUsageCache = {
        schemaVersion: 1,
        timezone: 'UTC',
        updatedAt: '2026-09-24T12:00:00Z',
        agents: {
          claude: undefined,
          codex: undefined,
          gemini: undefined,
          antigravity: undefined,
          opencode: undefined,
        },
      };

      const report = deriveReportFromCache(emptyCache, {
        days: 30,
        now: new Date('2026-09-24T12:00:00Z'),
      });

      expect(report.totals).toBeNull();
      expect(report.missingAgents).toHaveLength(5);
      for (const a of report.agents) {
        expect(a.totalTokens).toBeNull();
        expect(a.status).toBe('unavailable');
      }
    });

    it('reports partial state with totals covering only successful agents', () => {
      const now = new Date('2026-09-24T12:00:00Z');
      const claudeSnap: AgentCacheSnapshot = {
        agentId: 'claude',
        capturedAt: now.toISOString(),
        status: 'available',
        coverage: { complete: true, earliestDate: '2026-08-01' },
        totalTokens: 1000000,
        components: { input: 100000, output: 900000 },
        itemized: true,
        daily: [
          {
            date: '2026-09-24',
            totalTokens: 1000000,
            components: { input: 100000, output: 900000 },
          },
        ],
        models: [{ model: 'claude-opus-5', totalTokens: 1000000 }],
        sessions: [],
        sessionCount: 0,
      };

      const cache: TokenUsageCache = {
        schemaVersion: 1,
        timezone: 'UTC',
        updatedAt: now.toISOString(),
        agents: {
          claude: claudeSnap,
          codex: {
            agentId: 'codex',
            capturedAt: now.toISOString(),
            status: 'error',
            errorCode: 'timed_out',
            errorReason: 'Timed out after 30s',
            coverage: { complete: false, earliestDate: null },
            totalTokens: null,
            itemized: false,
            daily: [],
            models: [],
            sessions: [],
            sessionCount: null,
          },
          gemini: undefined,
          antigravity: undefined,
          opencode: undefined,
        },
      };

      const report = deriveReportFromCache(cache, { days: 30, now });
      expect(report.totals).not.toBeNull();
      expect(report.totals?.totalTokens).toBe(1000000);
      expect(report.isPartial).toBe(true);
      expect(report.missingAgents).toContain('codex');
      expect(report.missingAgents).toContain('gemini');

      const codexAgent = report.agents.find((a) => a.id === 'codex');
      expect(codexAgent?.status).toBe('error');
      expect(codexAgent?.errorCode).toBe('timed_out');
      expect(codexAgent?.errorReason).toBe('Timed out after 30s');
    });

    it('enforces privacy safety across complete serialized report', () => {
      const now = new Date('2026-09-24T12:00:00Z');
      const claudeSnap: AgentCacheSnapshot = {
        agentId: 'claude',
        capturedAt: now.toISOString(),
        status: 'available',
        coverage: { complete: true, earliestDate: '2026-08-01' },
        totalTokens: 500000,
        itemized: true,
        daily: [{ date: '2026-09-24', totalTokens: 500000 }],
        models: [],
        sessions: [
          {
            agent: 'claude',
            projectLabel: 'my-project',
            models: ['claude-sonnet-5'],
            totalTokens: 500000,
            lastActivity: now.toISOString(),
          },
        ],
        sessionCount: 1,
      };

      const cache: TokenUsageCache = {
        schemaVersion: 1,
        timezone: 'UTC',
        updatedAt: now.toISOString(),
        agents: {
          claude: claudeSnap,
          codex: undefined,
          gemini: undefined,
          antigravity: undefined,
          opencode: undefined,
        },
      };

      const report = deriveReportFromCache(cache, { days: 30, now });
      expect(() => assertPrivacySafe(report)).not.toThrow();
      expect(() => assertPrivacySafe(cache)).not.toThrow();
    });
  });

  describe('timezone boundaries and date sequences', () => {
    it('correctly handles Asia/Taipei timezone where local today differs from UTC today', () => {
      // 2026-09-23 at 20:30 UTC is 2026-09-24 at 04:30 local in Asia/Taipei (UTC+8)
      const dateNearMidnightUtc = new Date('2026-09-23T20:30:00Z');
      const localTodayTaipei = getLocalToday(
        'Asia/Taipei',
        dateNearMidnightUtc,
      );
      expect(localTodayTaipei).toBe('2026-09-24');

      // Negative offset: in America/Los_Angeles (UTC-7) it is still 2026-09-23
      const localTodayLA = getLocalToday(
        'America/Los_Angeles',
        dateNearMidnightUtc,
      );
      expect(localTodayLA).toBe('2026-09-23');
    });

    it('generates continuous date sequences and shifts dates accurately', () => {
      const seq = generateDateSequence('2026-09-20', '2026-09-24');
      expect(seq).toEqual([
        '2026-09-20',
        '2026-09-21',
        '2026-09-22',
        '2026-09-23',
        '2026-09-24',
      ]);
      expect(shiftDateString('2026-09-01', -1)).toBe('2026-08-31');
    });

    it('calculates 180-day history window and requested range bounds', () => {
      const now = new Date('2026-09-24T12:00:00Z');
      const history = calculateHistoryWindow('UTC', now, 180);
      expect(history.days).toBe(180);
      expect(history.until).toBe('2026-09-24');
      expect(history.since).toBe(shiftDateString('2026-09-24', -179));

      const range30 = calculateRangeWindow(30, 'UTC', now);
      expect(range30.days).toBe(30);
      expect(range30.until).toBe('2026-09-24');
      expect(range30.since).toBe(shiftDateString('2026-09-24', -29));
    });
  });
});
