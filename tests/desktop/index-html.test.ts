import { describe, expect, test } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('index.html', () => {
  test('loads renderer.js as an ES module', () => {
    const htmlPath = join(__dirname, '../../desktop/renderer/index.html');
    const htmlContent = readFileSync(htmlPath, 'utf8');
    expect(htmlContent).toContain(
      '<script type="module" src="renderer.js"></script>',
    );
    expect(htmlContent).toContain('<button id="openShell">Shell</button>');
    expect(htmlContent).toContain('id="stopAll"');
    expect(htmlContent).toContain('Stop All');
    // Attribute order and line breaks are Prettier's to decide; what matters
    // is that the fork-latest control still targets OpenCode.
    expect(htmlContent).toMatch(
      /<button[^>]*data-interactive="fork-latest"[^>]*data-agent="opencode"[^>]*>/,
    );
    expect(htmlContent).toContain('id="resumeRecovered"');
    expect(htmlContent).toContain('id="onboardingModal"');
    expect(htmlContent).toContain('id="onboardingProviders"');
    expect(htmlContent).toContain('id="onboardingChoose"');
  });

  test('keeps the 3a shell wired to the renderer', () => {
    const htmlPath = join(__dirname, '../../desktop/renderer/index.html');
    const rendererPath = join(__dirname, '../../desktop/renderer/renderer.js');
    const htmlContent = readFileSync(htmlPath, 'utf8');
    const rendererContent = readFileSync(rendererPath, 'utf8');

    // Shell regions the 3a layout introduces.
    expect(htmlContent).toContain('class="rail"');
    expect(htmlContent).toContain('class="command-bar"');
    expect(htmlContent).toContain('class="drawer"');
    expect(htmlContent).toContain('id="drawerToggle"');
    expect(htmlContent).toContain('id="topbarGit"');

    // Every id renderer.js resolves must exist in the markup.
    const referenced = new Set(
      [
        ...rendererContent.matchAll(/querySelector\('#([A-Za-z0-9_-]+)'\)/g),
      ].map((match) => match[1]),
    );
    const present = new Set(
      [...htmlContent.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map(
        (match) => match[1],
      ),
    );
    const missing = [...referenced].filter((id) => !present.has(id));
    expect(missing).toEqual([]);
  });

  test('exposes accessible Threads controls without unsupported wake UI', () => {
    const htmlPath = join(__dirname, '../../desktop/renderer/index.html');
    const rendererPath = join(__dirname, '../../desktop/renderer/renderer.js');
    const htmlContent = readFileSync(htmlPath, 'utf8');
    const rendererContent = readFileSync(rendererPath, 'utf8');

    expect(htmlContent).toContain('aria-labelledby="threadsModalTitle"');
    expect(htmlContent).toContain('for="threadsFilter"');
    expect(htmlContent).toContain('for="threadReplyBody"');
    expect(htmlContent).toContain('aria-label="Coordination threads"');
    expect(htmlContent).toContain('id="attentionTitle"');
    expect(htmlContent).not.toContain('<option value="wake">');
    expect(htmlContent).not.toContain('<option value="next_safe_turn">');
    expect(rendererContent).toContain("el('button', 'threads-list-button')");
    expect(rendererContent).toContain('textarea:not([disabled])');
    expect(rendererContent).toContain('threadsModal: closeThreads');
    expect(rendererContent).toContain('window.relay.stopAllTerminals()');
  });

  test('wires selected and all-session stop controls through isolated IPC', () => {
    const root = join(__dirname, '../../desktop');
    const htmlContent = readFileSync(join(root, 'renderer/index.html'), 'utf8');
    const rendererContent = readFileSync(
      join(root, 'renderer/renderer.js'),
      'utf8',
    );
    const preloadContent = readFileSync(join(root, 'preload.cjs'), 'utf8');
    const mainContent = readFileSync(join(root, 'main.mjs'), 'utf8');

    expect(htmlContent).toContain('id="stop" disabled>Stop Session');
    expect(htmlContent).toContain('id="stopAll"');
    expect(rendererContent).toContain('window.relay.stopTerminal(active.id)');
    expect(rendererContent).toContain('window.relay.stopAllTerminals()');
    expect(preloadContent).toContain(
      "ipcRenderer.invoke('relay:terminal-stop-all')",
    );
    expect(mainContent).toContain("ipcMain.handle('relay:terminal-stop-all'");
  });

  test('wires terminal control loss and recovery into renderer input state', () => {
    const root = join(__dirname, '../../desktop');
    const rendererContent = readFileSync(
      join(root, 'renderer/renderer.js'),
      'utf8',
    );
    const preloadContent = readFileSync(join(root, 'preload.cjs'), 'utf8');
    const mainContent = readFileSync(join(root, 'main.mjs'), 'utf8');

    expect(mainContent).toContain(
      "forwardTerminalControl(terminalId, true, 'disconnected')",
    );
    expect(mainContent).toContain(
      "forwardTerminalControl(terminalId, false, 'reconnected')",
    );
    expect(mainContent).toContain('void restoreRendererTerminalControl()');
    expect(preloadContent).toContain(
      "ipcRenderer.on('relay:terminal-control', listener)",
    );
    expect(rendererContent).toContain('window.relay.onTerminalControl?.(');
    expect(rendererContent).toContain(
      'tab.terminal.options.disableStdin = readOnly',
    );
  });
});
