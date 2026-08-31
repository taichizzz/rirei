import type { DOMElement } from 'ink';
import { describe, expect, it } from 'vitest';
import {
  consumeMouseInput,
  containsPoint,
  elementBounds,
} from '../../src/tui/mouse.js';

describe('TUI mouse input', () => {
  it('parses SGR clicks, releases, and wheel movement', () => {
    const parsed = consumeMouseInput(
      '\x1b[<0;12;7M\x1b[<0;12;7m\x1b[<64;4;3M\x1b[<65;4;3M',
    );

    expect(parsed).toEqual({
      events: [
        { button: 'left', action: 'press', x: 12, y: 7 },
        { button: 'left', action: 'release', x: 12, y: 7 },
        { button: 'wheel-up', action: 'press', x: 4, y: 3 },
        { button: 'wheel-down', action: 'press', x: 4, y: 3 },
      ],
      remainder: '',
    });
  });

  it('retains a fragmented SGR event for the next input chunk', () => {
    const first = consumeMouseInput('ordinary input\x1b[<0;18');
    expect(first.events).toEqual([]);
    expect(first.remainder).toBe('\x1b[<0;18');

    expect(consumeMouseInput(`${first.remainder};9M`)).toEqual({
      events: [{ button: 'left', action: 'press', x: 18, y: 9 }],
      remainder: '',
    });

    const escapeOnly = consumeMouseInput('\x1b');
    expect(escapeOnly.remainder).toBe('\x1b');
    const prefix = consumeMouseInput(`${escapeOnly.remainder}[<`);
    expect(prefix.remainder).toBe('\x1b[<');
    expect(consumeMouseInput(`${prefix.remainder}0;5;6M`).events).toEqual([
      { button: 'left', action: 'press', x: 5, y: 6 },
    ]);
  });

  it('maps nested Ink layout coordinates to clickable bounds', () => {
    const yogaNode = (
      left: number,
      top: number,
      width: number,
      height: number,
    ) => ({
      getComputedLeft: () => left,
      getComputedTop: () => top,
      getComputedWidth: () => width,
      getComputedHeight: () => height,
    });
    const root = {
      yogaNode: yogaNode(0, 0, 80, 24),
      parentNode: undefined,
    } as unknown as DOMElement;
    const panel = {
      yogaNode: yogaNode(2, 3, 30, 10),
      parentNode: root,
    } as unknown as DOMElement;
    const button = {
      yogaNode: yogaNode(4, 2, 12, 3),
      parentNode: panel,
    } as unknown as DOMElement;

    const bounds = elementBounds(button);
    expect(bounds).toEqual({ x: 7, y: 6, width: 12, height: 3 });
    expect(containsPoint(bounds!, 7, 6)).toBe(true);
    expect(containsPoint(bounds!, 18, 8)).toBe(true);
    expect(containsPoint(bounds!, 19, 8)).toBe(false);
  });
});
