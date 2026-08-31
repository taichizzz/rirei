import type { DOMElement } from 'ink';

export const ENABLE_MOUSE = '\x1b[?1000h\x1b[?1006h';
export const DISABLE_MOUSE = '\x1b[?1000l\x1b[?1006l';

export interface MouseEvent {
  readonly button: 'left' | 'middle' | 'right' | 'wheel-up' | 'wheel-down';
  readonly action: 'press' | 'release';
  readonly x: number;
  readonly y: number;
}

export interface MouseBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const SGR_MOUSE = new RegExp(
  `${String.fromCharCode(27)}\\[<(\\d+);(\\d+);(\\d+)([Mm])`,
  'g',
);

export function consumeMouseInput(input: string): {
  events: MouseEvent[];
  remainder: string;
} {
  const events: MouseEvent[] = [];
  let consumed = 0;
  for (const match of input.matchAll(SGR_MOUSE)) {
    const code = Number(match[1]);
    const x = Number(match[2]);
    const y = Number(match[3]);
    if (Number.isSafeInteger(code) && x > 0 && y > 0) {
      const button =
        code & 64
          ? code & 1
            ? 'wheel-down'
            : 'wheel-up'
          : (['left', 'middle', 'right'] as const)[code & 3];
      if (button) {
        events.push({
          button,
          action: match[4] === 'M' ? 'press' : 'release',
          x,
          y,
        });
      }
    }
    consumed = (match.index ?? 0) + match[0].length;
  }

  const tail = input.slice(consumed);
  const prefix = ['\x1b[<', '\x1b[', '\x1b'].find((value) =>
    tail.endsWith(value),
  );
  const partialOffset = tail.lastIndexOf('\x1b[<');
  const remainder =
    partialOffset >= 0 ? tail.slice(partialOffset).slice(-64) : (prefix ?? '');
  return { events, remainder };
}

export function elementBounds(element: DOMElement): MouseBounds | null {
  if (!element.yogaNode) return null;
  let x = 1;
  let y = 1;
  let current: DOMElement | undefined = element;
  while (current?.yogaNode) {
    x += current.yogaNode.getComputedLeft();
    y += current.yogaNode.getComputedTop();
    current = current.parentNode;
  }
  return {
    x,
    y,
    width: element.yogaNode.getComputedWidth(),
    height: element.yogaNode.getComputedHeight(),
  };
}

export function containsPoint(
  bounds: MouseBounds,
  x: number,
  y: number,
): boolean {
  return (
    x >= bounds.x &&
    x < bounds.x + bounds.width &&
    y >= bounds.y &&
    y < bounds.y + bounds.height
  );
}
