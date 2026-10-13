import { describe, expect, test } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import vm from 'node:vm';

/** Source of a top-level `function name(...) { ... }` in renderer.js. */
function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`renderer.js has no function ${name}`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}' && --depth === 0)
      return source.slice(start, i + 1);
  }
  throw new Error(`Unbalanced function ${name}`);
}

describe('desktop Usage View integration & UI contract', () => {
  const root = join(__dirname, '../../desktop');
  const htmlContent = readFileSync(join(root, 'renderer/index.html'), 'utf8');
  const rendererContent = readFileSync(
    join(root, 'renderer/renderer.js'),
    'utf8',
  );
  const preloadContent = readFileSync(join(root, 'preload.cjs'), 'utf8');
  const mainContent = readFileSync(join(root, 'main.mjs'), 'utf8');

  test('declares all 10 usage widgets and opt-in card in index.html', () => {
    // Stage section and opt-in card
    expect(htmlContent).toContain('id="usageView"');
    expect(htmlContent).toContain('id="usageOptInCard"');
    expect(htmlContent).toContain('id="enableUsageBtn"');
    expect(htmlContent).toContain('id="usageDashWrapper"');

    // 10 dashboard widgets from spec
    expect(htmlContent).toContain('id="range"');
    expect(htmlContent).toContain('id="agentChips"');
    expect(htmlContent).toContain('id="heroValue"');
    expect(htmlContent).toContain('id="heroSub"');
    expect(htmlContent).toContain('id="tiles"');
    expect(htmlContent).toContain('id="daily"');
    expect(htmlContent).toContain('id="dailyTable"');
    expect(htmlContent).toContain('id="rank"');
    expect(htmlContent).toContain('id="heat"');
    expect(htmlContent).toContain('id="quota"');
    expect(htmlContent).toContain('id="models"');
    expect(htmlContent).toContain('id="breakdown"');
    expect(htmlContent).toContain('id="sessions"');
    expect(htmlContent).toContain('id="claudeNotice"');
    expect(htmlContent).toContain('id="usageTip"');
  });

  test('wires usage button to stage navigation without disposing terminals', () => {
    // Usage button in command band
    expect(htmlContent).toContain('id="usageBtn"');

    // openUsageView and closeUsageView toggle hidden attribute
    expect(rendererContent).toContain('openUsageView()');
    expect(rendererContent).toContain('closeUsageView()');
    expect(rendererContent).toContain('mainContent.hidden = true');
    expect(rendererContent).toContain('usageView.hidden = false');
    expect(rendererContent).toContain('usageView.hidden = true');
    expect(rendererContent).toContain('mainContent.hidden = false');

    // Does NOT clear terminalTabs or terminalContainer
    expect(rendererContent).not.toMatch(
      /openUsageView\(\)\s*\{[^}]*terminalTabs\.clear\(\)/,
    );
    expect(rendererContent).not.toMatch(
      /openUsageView\(\)\s*\{[^}]*terminalContainer\.innerHTML\s*=\s*['"]['"]/,
    );
  });

  test('wires IPC handlers across main, preload, and renderer', () => {
    // Preload exposure
    expect(preloadContent).toContain('usageTokens:');
    expect(preloadContent).toContain("ipcRenderer.invoke('relay:usage-tokens'");
    expect(preloadContent).toContain('usageOptIn:');
    expect(preloadContent).toContain("ipcRenderer.invoke('relay:usage-opt-in'");
    expect(preloadContent).toContain('setUsageOptIn:');
    expect(preloadContent).toContain(
      "ipcRenderer.invoke('relay:usage-set-opt-in'",
    );

    // Main process handlers
    expect(mainContent).toContain("ipcMain.handle('relay:usage-tokens'");
    expect(mainContent).toContain("ipcMain.handle('relay:usage-opt-in'");
    expect(mainContent).toContain("ipcMain.handle('relay:usage-set-opt-in'");

    // Renderer calls
    expect(rendererContent).toContain('window.relay.usageOptIn()');
    expect(rendererContent).toContain('window.relay.setUsageOptIn(');
    expect(rendererContent).toContain('window.relay.usageTokens(');
  });

  test('binds keyboard Escape to close usage stage and return to task view', () => {
    expect(rendererContent).toContain('closeUsageView()');
    // Escape key closes usage view
    expect(rendererContent).toMatch(
      /Escape.*closeUsageView|closeUsageView.*Escape/s,
    );
  });

  test('guards out-of-order responses with usageLoadSeq', () => {
    expect(rendererContent).toContain('let usageLoadSeq = 0;');
    expect(rendererContent).toContain('const seq = ++usageLoadSeq;');
    expect(rendererContent).toContain('if (seq !== usageLoadSeq) return;');
  });

  test('formats error codes gracefully and tracks per-agent loading states', () => {
    expect(rendererContent).toContain('function formatErrorCode(');
    expect(rendererContent).toContain('loadingAgentIds');
    expect(rendererContent).toContain("'Timed out'");
    expect(rendererContent).toContain("'ccusage not found'");
  });

  test('re-fits terminals on close via syncSize()', () => {
    expect(rendererContent).toMatch(
      /function closeUsageView\(\)\s*\{[\s\S]*syncSize\(\)/,
    );
  });

  test('does not invent reasoning tokens with fake multipliers', () => {
    expect(rendererContent).not.toContain('codexOutput * 0.4');
    expect(rendererContent).not.toMatch(/Math\.round\(.*\* 0\.4\)/);
  });

  test('never shows placeholder quota values when Codex reports nothing', () => {
    expect(rendererContent).not.toMatch(/codexFiveHour \?\? \d/);
    expect(rendererContent).not.toMatch(/codexWeek \?\? \d/);
    expect(rendererContent).not.toContain('Resets in 1 h 12 min');
    expect(rendererContent).not.toContain('Resets Tue 09:00');
    expect(rendererContent).toContain('Not reported');
  });

  test('shows days after the last capture as not collected, never zero', () => {
    expect(rendererContent).toMatch(/through && dateStr > through\s*\?\s*null/);
    expect(rendererContent).toContain('Not collected yet');
    expect(rendererContent).toContain('url(#usageNcHatch)');
  });

  test('keeps the heatmap on its own 13-week calendar', () => {
    expect(rendererContent).toMatch(
      /function renderHeat\(\)\s*\{[\s\S]*?getCalendarDays\(\)/,
    );
  });

  test('breaks a small remainder out as Not broken down', () => {
    expect(rendererContent).toContain('Not broken down');
    expect(rendererContent).toContain('unitemizedTokens');
  });

  test('drives the Claude retention notice from coverage, not the range length', () => {
    expect(htmlContent).toContain('id="claudeNoticeText"');
    expect(rendererContent).not.toMatch(
      /usageRangeDays > 30 && !usageHiddenAgents/,
    );
    expect(rendererContent).toMatch(/isAgentPartial\('claude'\)/);
  });

  test('returns to the task stage from any rail entry, not only Escape', () => {
    expect(rendererContent).toMatch(
      /function selectRailPanel\(selected\)\s*\{\s*[^}]*usageView\.hidden\)\s*closeUsageView\(\)/,
    );
  });

  test('reads machine-wide plan windows with no project open', () => {
    expect(mainContent).toContain('request?.project ?? os.homedir()');
    expect(rendererContent).not.toContain(
      'project && latestLivePlans.length === 0',
    );
  });

  test('never presents an old Codex reading as current', () => {
    expect(rendererContent).toContain('Reset since last reading');
    expect(rendererContent).toMatch(
      /resetMs <= Date\.now\(\)\) state = 'reset'/,
    );
    expect(rendererContent).toContain('As of ');
  });

  test('compares only the selected agents and never shows a failed agent as zero', () => {
    const names = [
      'dShort',
      'fmtDate',
      'joinNames',
      'usageAgentReport',
      'shownDataThrough',
      'shownComparison',
    ];
    const agent = (id: string, name: string, now: number, prev: number) => ({
      id,
      name,
      status: 'available',
      totalTokens: now,
      coverage: { complete: true, dataThrough: '2026-09-30' },
      previous: { tokens: prev },
    });
    const context: Record<string, unknown> = {
      USAGE_AGENTS: [
        { id: 'claude', name: 'Claude' },
        { id: 'codex', name: 'Codex' },
        { id: 'gemini', name: 'Gemini' },
      ],
      usageHiddenAgents: new Set<string>(),
      tokenUsageReport: {
        range: { since: '2026-09-24', until: '2026-09-30' },
        comparison: { previousSince: '2026-09-17' },
        agents: [
          // Claude halves; Codex grows enough that the total is +233%
          agent('claude', 'Claude', 50, 100),
          agent('codex', 'Codex', 950, 200),
          { id: 'gemini', name: 'Gemini', status: 'error', coverage: {} },
        ],
      },
    };
    vm.runInNewContext(
      `const shownUsageAgents = () => USAGE_AGENTS.filter((a) => !usageHiddenAgents.has(a.id));\n${names
        .map((n) => extractFunction(rendererContent, n))
        .join('\n')}\nglobalThis.shownComparison = shownComparison;`,
      context,
    );
    const hidden = context.usageHiddenAgents as Set<string>;
    const compare = context.shownComparison as () => {
      pct?: number;
      reason?: string;
    };

    hidden.add('gemini');
    expect(compare().pct).toBe(233);
    hidden.add('codex');
    expect(compare().pct).toBe(-50);

    // Only the failed agent selected: a reason, never a number
    hidden.clear();
    hidden.add('claude');
    hidden.add('codex');
    expect(compare().pct).toBeUndefined();
    expect(compare().reason).toContain('Gemini');

    // The hero's availability follows the selection too
    expect(rendererContent).toMatch(
      /const shownAvailable = shown\.filter\(\s*\(a\) => usageAgentReport\(a\.id\)\?\.status === 'available'/,
    );
    expect(rendererContent).not.toContain(
      'tokenUsageReport.comparison.percentage',
    );
  });

  test('labels Updated with the last scan time, not the report build time', () => {
    expect(
      extractFunction(rendererContent, 'updateFreshnessTime'),
    ).not.toContain('generatedAt');
    expect(extractFunction(rendererContent, 'updateFreshnessTime')).toContain(
      'capturedAt',
    );
  });
});
