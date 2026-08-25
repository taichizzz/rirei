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
    expect(htmlContent).toContain(
      'data-interactive="fork-latest" data-agent="opencode"',
    );
    expect(htmlContent).toContain('id="resumeRecovered"');
  });
});
